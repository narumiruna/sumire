import { mkdtemp, readdir, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { backup, DatabaseSync } from "node:sqlite"
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import type { ConversationId } from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { inherited, thinkingSchema } from "@narumitw/sumire-policy"
import { z } from "zod"
import type { AdminStore } from "./store.js"

/** Read a consistent copy through Pi's storage API; never open a scheduler or modify the source. */
export async function readLegacySelection(file: string) {
  if ((await stat(file)).size > 1024 * 1024 * 1024)
    throw new Error("Session is too large for automatic import")
  const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-admin-import-"))
  let source: DatabaseSync | undefined
  try {
    source = new DatabaseSync(file, { readOnly: true })
    const copy = path.join(directory, "session.sqlite")
    const deadline = Date.now() + 30_000
    await backup(source, copy, {
      progress: () => {
        if (Date.now() > deadline) throw new Error("Session import timed out")
      },
    })
    const storage = await openNodeSqliteStorage(copy)
    try {
      const sessionRecord = await storage.findDocument(
        { kind: "sumire.session", scope: { kind: "session" } },
        "current",
        context,
      )
      const session =
        sessionRecord && (await storage.document(sessionRecord.id, "current", context))
      const active = z.number().int().positive().parse(session?.value.activeConversation)
      const agentRecord = await storage.findDocument(
        {
          kind: "pi.agent",
          scope: { kind: "conversation", conversationId: active as ConversationId },
        },
        "current",
        context,
      )
      const agent = agentRecord && (await storage.document(agentRecord.id, "current", context))
      const parsed = z
        .object({
          model: z.object({ provider: z.string().min(1), modelId: z.string().min(1) }),
          thinkingLevel: thinkingSchema,
        })
        .parse(agent?.value)
      return {
        model: `${parsed.model.provider}/${parsed.model.modelId}`,
        thinking: parsed.thinkingLevel,
      }
    } finally {
      await storage.close(context)
    }
  } finally {
    try {
      source?.close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}

export async function importLegacyModels(store: AdminStore, root: string, runtime: ModelRuntime) {
  if (store.db.prepare("SELECT name FROM imports WHERE name='models'").get()) return
  const snapshot = store.snapshot()
  const policy = snapshot.policy
  const failures: number[] = []
  let imported = 0
  let entries: string[] = []
  try {
    entries = await readdir(root)
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw error
  }
  const deadline = Date.now() + 60_000
  let scanned = 0
  for (const name of entries.slice(0, 1000)) {
    if (Date.now() > deadline) break
    scanned++
    const id = Number(name)
    if (!Number.isSafeInteger(id) || id === 0 || String(id) !== name) continue
    store.observe(id, id > 0 ? "private" : "group", name, "inferred")
    try {
      const value = await readLegacySelection(path.join(root, name, "durable/session.sqlite"))
      const split = value.model.indexOf("/")
      const model = runtime.getPhysicalModel(
        value.model.slice(0, split),
        value.model.slice(split + 1),
      )
      if (!model || !getSupportedThinkingLevels(model).includes(value.thinking)) {
        failures.push(id)
        continue
      }
      policy.models = [...new Set([...policy.models, value.model])]
      policy.chats[name] = { ...inherited, enabled: true, models: [value.model], ...value }
      imported++
    } catch {
      failures.push(id)
    }
  }
  policy.providers = runtime
    .getProviders()
    .filter((p) => runtime.hasConfiguredAuth(p.id))
    .map((p) => ({ id: p.id, enabled: true, models: [] }))
    .slice(0, 64)
  store.db.exec("BEGIN IMMEDIATE")
  try {
    store.db
      .prepare("UPDATE settings SET policy=? WHERE id=1 AND revision=?")
      .run(JSON.stringify(policy), snapshot.revision)
    store.db.prepare("INSERT INTO imports VALUES ('models',?)").run(
      JSON.stringify({
        imported,
        failedChatIds: failures,
        unscannedEntries: entries.length - scanned,
        reviewRequired: true,
      }),
    )
    store.audit(
      "system",
      "models.import",
      snapshot.revision,
      failures.length ? "partial; review import report" : "imported; review required",
    )
    store.db.exec("COMMIT")
  } catch (error) {
    store.db.exec("ROLLBACK")
    throw error
  }
}
