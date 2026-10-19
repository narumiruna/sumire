import { copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { JsonValue } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import { Type } from "@earendil-works/pi-ai"
import { createModels } from "@earendil-works/pi-ai/models"
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux"
import {
  CompactionTask,
  type Conversation,
  createRegistry,
  defineExtension,
  defineTask,
  defineTool,
  Harness,
  hook,
  type Registry,
} from "@earendil-works/pi-durable"
import { CodemodeStoreDoc as NativeStore } from "@earendil-works/pi-durable/codemode"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  CodemodeMigrationDoc,
  forkCodemodeConversation,
  LegacyCodemodeCallTask,
  migrateCodemodeStores,
} from "../src/agent/durable-migration.js"
import { CodemodeStoreDoc as LegacyStore } from "../src/agent/durable-state.js"

const harnesses = new Set<Harness>()
const directories: string[] = []
const cleanupExtension = defineExtension({
  name: "legacy-codemode-cleanup",
  tasks: [LegacyCodemodeCallTask],
})

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "sumire-codemode-migration-"))
  directories.push(directory)
  const file = path.join(directory, "chat.sqlite")
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const open = async (database = file, registry: Registry = createRegistry()) => {
    const harness = await Harness.open(
      await openNodeSqliteStorage(database),
      {
        models,
        registry,
        settings: { compaction: { keepRecentTokens: 1 }, documentRetentionMs: 0 },
      },
      context,
    )
    harnesses.add(harness)
    return harness
  }
  return { directory, file, open, faux }
}

async function close(harness: Harness) {
  await harness.close(context)
  harnesses.delete(harness)
}

async function point(
  conversation: Conversation,
  values: Record<string, JsonValue>,
  native = false,
) {
  return conversation.commit(async (tx) => {
    const store = await tx.doc(native ? NativeStore : LegacyStore, conversation.id)
    store.values = values
    return tx.appendEntry(conversation.id, { kind: "fixture.point", data: values })
  }, context)
}

async function nativeValues(harness: Harness, conversation: Conversation) {
  return (await harness.snapshot(NativeStore, conversation.id, context))?.values
}

async function history(conversation: Conversation) {
  return (await conversation.entries({ order: "ascending" }, 100, undefined, context)).items
}

afterEach(async () => {
  for (const harness of harnesses) await harness.close(context)
  harnesses.clear()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

describe("codemode store migration", () => {
  it("copies current legacy values atomically but restores both historical points without rewriting history", async () => {
    const { open } = await fixture()
    const harness = await open()
    const source = await harness.root(context)
    const first = await point(source, { value: 1, nested: { retained: [true, null] } })
    const second = await point(source, { value: 2 })
    const before = await history(source)
    const commits: string[][] = []
    const stop = harness.subscribeCommits((publication) => {
      commits.push(
        publication.changes.flatMap((change) =>
          change.type === "document" ? [change.record.kind] : [],
        ),
      )
    })
    await migrateCodemodeStores(harness, context)
    stop()
    expect(commits).toContainEqual([
      NativeStore.definition.kind,
      CodemodeMigrationDoc.definition.kind,
    ])
    expect(await nativeValues(harness, source)).toEqual({ value: 2 })
    expect(await harness.snapshot(LegacyStore, source.id, context)).toEqual({
      values: { value: 2 },
    })
    expect(await history(source)).toEqual(before)
    expect(await harness.snapshotAsOf(NativeStore, source.id, second.id, context)).toBeUndefined()

    const cutover = await point(source, { value: 3 }, true)
    const creationCommits: string[][] = []
    const stopForks = harness.subscribeCommits((publication) => {
      creationCommits.push(publication.changes.map((change) => change.type))
    })
    const oldFirst = await forkCodemodeConversation(harness, source, first.id, context)
    stopForks()
    expect(creationCommits).toHaveLength(1)
    expect(creationCommits[0]).toContain("conversation")
    expect(creationCommits[0]).toContain("document")
    const oldSecond = await forkCodemodeConversation(harness, source, second.id, context)
    const newBranch = await forkCodemodeConversation(harness, source, cutover.id, context)
    expect(await nativeValues(harness, oldFirst)).toEqual(first.data)
    expect(await nativeValues(harness, oldSecond)).toEqual({ value: 2 })
    expect(await nativeValues(harness, newBranch)).toEqual({ value: 3 })
    expect(await nativeValues(harness, source)).toEqual({ value: 3 })
    await point(oldFirst, { independent: true }, true)
    expect(await nativeValues(harness, source)).toEqual({ value: 3 })
    expect(await nativeValues(harness, oldSecond)).toEqual({ value: 2 })
  })

  it("never restores stale legacy keys over an existing empty native store or deleted native keys", async () => {
    const { open } = await fixture()
    const harness = await open()
    const source = await harness.root(context)
    await point(source, { stale: "legacy", removed: 1 })
    const empty = await point(source, {}, true)
    await migrateCodemodeStores(harness, context)
    expect(await nativeValues(harness, source)).toEqual({})
    expect(
      await nativeValues(
        harness,
        await forkCodemodeConversation(harness, source, empty.id, context),
      ),
    ).toEqual({})
    await point(source, { removed: "native", keep: 0 }, true)
    const deleted = await source.commit(async (tx) => {
      delete (await tx.doc(NativeStore, source.id)).values.removed
      return tx.appendEntry(source.id, { kind: "fixture.deleted" })
    }, context)
    const branch = await forkCodemodeConversation(harness, source, deleted.id, context)
    expect(await nativeValues(harness, branch)).toEqual({ keep: 0 })
    await migrateCodemodeStores(harness, context)
    expect(await nativeValues(harness, source)).toEqual({ keep: 0 })
  })

  it("migrates abandoned and inherited conversations across every scan page, not only the active root", async () => {
    const { open } = await fixture()
    const harness = await open()
    const root = await harness.root(context)
    const ancestor = await point(root, { inherited: 1 })
    const abandoned = await root.fork(ancestor.id, { ownership: { kind: "ownerless" } }, context)
    const abandonedPoint = await point(abandoned, { abandoned: 2 })
    const inherited = await abandoned.fork(
      abandonedPoint.id,
      { ownership: { kind: "ownerless" } },
      context,
    )
    for (let index = 0; index < 100; index++)
      await harness.createConversation({ ownership: { kind: "ownerless" } }, context)
    const last = await harness.createConversation({ ownership: { kind: "ownerless" } }, context)
    await point(last, { lastPage: true })
    await point(root, { active: 3 })
    await migrateCodemodeStores(harness, context)
    expect(await nativeValues(harness, root)).toEqual({ active: 3 })
    expect(await nativeValues(harness, abandoned)).toEqual({ abandoned: 2 })
    expect(await nativeValues(harness, inherited)).toEqual({ abandoned: 2 })
    expect(await nativeValues(harness, last)).toEqual({ lastPage: true })
    const ancient = await forkCodemodeConversation(harness, inherited, ancestor.id, context)
    expect(await nativeValues(harness, ancient)).toEqual({ inherited: 1 })
    const forkAgain = await forkCodemodeConversation(harness, ancient, ancestor.id, context)
    expect(await nativeValues(harness, forkAgain)).toEqual({ inherited: 1 })
  })

  it("is idempotent after reopen and initializes empty conversations without leaking between chat databases", async () => {
    const { open, directory } = await fixture()
    const first = await open()
    const root = await first.root(context)
    await point(root, { chat: "first" })
    await migrateCodemodeStores(first, context)
    await close(first)
    const reopened = await open()
    const commits = vi.fn()
    const stop = reopened.subscribeCommits(commits)
    await migrateCodemodeStores(reopened, context)
    stop()
    expect(commits).not.toHaveBeenCalled()
    expect(await nativeValues(reopened, await reopened.root(context))).toEqual({ chat: "first" })
    const other = await open(path.join(directory, "other-chat.sqlite"))
    const otherRoot = await other.root(context)
    await migrateCodemodeStores(other, context)
    expect(await nativeValues(other, otherRoot)).toEqual({})
    expect(await other.snapshot(LegacyStore, otherRoot.id, context)).toBeUndefined()
    expect(await other.snapshot(CodemodeMigrationDoc, otherRoot.id, context)).toEqual({
      migrated: true,
    })
    await point(otherRoot, { chat: "second" }, true)
    expect(await nativeValues(reopened, root)).toEqual({ chat: "first" })
  })

  it("retries a partially completed migration without overwriting already migrated native values", async () => {
    const { open } = await fixture()
    const harness = await open()
    const root = await harness.root(context)
    const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context)
    await point(root, { legacy: 1 })
    await point(other, { legacy: 2 })
    await root.commit(async (tx) => {
      const native = await tx.doc(NativeStore, root.id)
      native.values = { alreadyMigrated: true }
      const marker = await tx.doc(CodemodeMigrationDoc, root.id)
      marker.migrated = true
    }, context)
    await close(harness)
    const reopened = await open()
    await migrateCodemodeStores(reopened, context)
    expect(await nativeValues(reopened, root)).toEqual({ alreadyMigrated: true })
    expect(await nativeValues(reopened, other)).toEqual({ legacy: 2 })
  })

  it("rejects migration after the scheduler starts", async () => {
    const { open } = await fixture()
    const harness = await open()
    harness.resume()
    await expect(migrateCodemodeStores(harness, context)).rejects.toThrow("paused Harness")
  })

  it("preserves historical legacy and native fork values through supported compaction", async () => {
    const { open, faux } = await fixture()
    const registry = createRegistry()
    registry.install(
      defineExtension({
        name: "fixture-compaction",
        hooks: [hook(CompactionTask, { beforeCompact: () => ({ summary: "Fixture summary" }) })],
      }),
    )
    const harness = await open(undefined, registry)
    const model = faux.getModel()
    const source = await harness.root(context, {
      agent: { model: { provider: model.provider, modelId: model.id } },
    })
    const old = await point(source, { old: true })
    await migrateCodemodeStores(harness, context)
    const native = await point(source, { new: true }, true)
    for (let index = 0; index < 6; index++) {
      await source.commit(async (tx) => {
        await tx.appendEntry(source.id, {
          kind: "fixture.input",
          model: [
            { role: "user", content: `Question ${index} ${"long ".repeat(100)}`, timestamp: 0 },
          ],
        })
        await tx.appendEntry(source.id, {
          kind: "fixture.answer",
          model: [fauxAssistantMessage(`Answer ${index}`)],
        })
      }, context)
    }
    const compaction = await harness.waitForTask(await source.compact(undefined, context), context)
    expect(compaction.state.outcome.status).toBe("completed")
    expect((await history(source)).some((entry) => entry.kind === "pi.compaction")).toBe(true)
    const oldFork = await forkCodemodeConversation(harness, source, old.id, context)
    const nativeFork = await forkCodemodeConversation(harness, source, native.id, context)
    expect(await nativeValues(harness, oldFork)).toEqual({ old: true })
    expect(await nativeValues(harness, nativeFork)).toEqual({ new: true })
  })

  it("restores a closed SQLite backup if migration is rolled back before new work", async () => {
    const { open, file, directory } = await fixture()
    const legacy = await open()
    const root = await legacy.root(context)
    const old = await point(root, { beforeUpgrade: [1, 2] })
    await close(legacy)
    const backup = path.join(directory, "pre-upgrade.sqlite")
    await copyFile(file, backup)
    const upgrade = await open()
    await migrateCodemodeStores(upgrade, context)
    expect(await nativeValues(upgrade, root)).toEqual({ beforeUpgrade: [1, 2] })
    await close(upgrade)
    await copyFile(backup, file)
    const restored = await open()
    expect(await restored.snapshot(NativeStore, root.id, context)).toBeUndefined()
    expect(await restored.snapshot(CodemodeMigrationDoc, root.id, context)).toBeUndefined()
    expect(await restored.snapshotAsOf(LegacyStore, root.id, old.id, context)).toEqual({
      values: { beforeUpgrade: [1, 2] },
    })
    await migrateCodemodeStores(restored, context)
    expect(await nativeValues(restored, root)).toEqual({ beforeUpgrade: [1, 2] })
  })
})

const oldInput = {
  name: "publish",
  args: { body: "once" },
  callId: "parent/1",
  parentCallId: "parent",
}

describe("legacy codemode task cleanup", () => {
  it.each(["call", "interrupted"] as const)(
    "settles persisted %s work without running effects",
    async (phase) => {
      const { open } = await fixture()
      const old = await open()
      const root = await old.root(context)
      const effects = vi.fn()
      const previousTask = defineTask({
        name: "sumire.codemode-call",
        version: 1,
        initial: () => ({ phase }),
        phases: {
          call: async () => {
            effects()
          },
          interrupted: async () => {
            effects()
          },
        },
        abort: async () => {},
      })
      const id = await root.commit(
        (tx) => tx.createTask(previousTask, oldInput, { ownership: { kind: "conversation" } }),
        context,
      )
      await close(old)
      const registry = createRegistry()
      const harness = await open(undefined, registry)
      expect((await harness.inspect(context)).tasks[0]?.state).toMatchObject({
        kind: "blocked",
        reason: "missing_task",
      })
      registry.install(cleanupExtension)
      await migrateCodemodeStores(harness, context)
      const result = await harness.waitForTask(id, context)
      expect(result.state.outcome).toMatchObject({
        status: "completed",
        result: {
          isError: true,
          content: [
            {
              type: "text",
              text:
                phase === "interrupted"
                  ? "Nested tool was interrupted; inspect side effects before retrying."
                  : "Legacy nested tool was not executed; inspect side effects before retrying.",
            },
          ],
        },
      })
      expect(effects).not.toHaveBeenCalled()
      expect((await harness.inspect(context)).tasks).toEqual([])
    },
  )

  it.each([false, true])(
    "retains abort cleanup (abandoned on restart: %s)",
    async (abandonOnRestart) => {
      const { open } = await fixture()
      const old = await open()
      const root = await old.root(context)
      const id = await root.commit(
        (tx) =>
          tx.createTask(LegacyCodemodeCallTask, oldInput, {
            ownership: { kind: "conversation" },
            abandonOnRestart,
          }),
        context,
      )
      await close(old)
      const registry = createRegistry()
      registry.install(cleanupExtension)
      const reopened = await open(undefined, registry)
      await migrateCodemodeStores(reopened, context)
      if (!abandonOnRestart) await reopened.abortTask(id, context)
      expect((await reopened.waitForTask(id, context)).state.outcome).toEqual({ status: "aborted" })
    },
  )

  it("does not replay an old unsafe same-name codemode call under a new safe implementation", async () => {
    const { open, faux } = await fixture()
    const effects = vi.fn()
    const newExecute = vi.fn(async () => ({
      output: [{ type: "text" as const, text: "new code" }],
    }))
    const registry = createRegistry()
    let childCreated = false
    registry.install(
      defineExtension({
        name: "codemode",
        tools: [
          defineTool({
            name: "codemode",
            description: "Legacy unsafe codemode",
            parameters: Type.Object({ code: Type.String() }),
            replay: "unsafe",
            execute: async (_args, api, callContext) => {
              effects()
              await api.createTask(
                LegacyCodemodeCallTask,
                oldInput,
                { ownership: { kind: "task", taskId: api.taskId } },
                callContext,
              )
              childCreated = true
              await new Promise<void>((resolve) => {
                callContext.abortSignal?.addEventListener("abort", () => resolve(), { once: true })
              })
              callContext.abortSignal?.throwIfAborted()
              return {}
            },
          }),
        ],
      }),
    )
    const old = await open(undefined, registry)
    const model = faux.getModel()
    const root = await old.root(context, {
      agent: { model: { provider: model.provider, modelId: model.id } },
    })
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code: "publish once" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Interrupted call handled"),
    ])
    const submission = await root.submit(
      { type: "input", content: "do once", requestId: "once" },
      context,
    )
    await vi.waitFor(() => expect(childCreated).toBe(true))
    await close(old)
    const nextRegistry = createRegistry()
    nextRegistry.install(
      defineExtension({
        name: "codemode",
        tools: [
          defineTool({
            name: "codemode",
            description: "Native safe codemode",
            parameters: Type.Object({ code: Type.String() }),
            replay: "safe",
            execute: newExecute,
          }),
        ],
      }),
    )
    nextRegistry.install(cleanupExtension)
    const reopened = await open(undefined, nextRegistry)
    await migrateCodemodeStores(reopened, context)
    const pending = await reopened.submission(submission.id, context)
    expect((await pending?.wait(context))?.status).toBe("done")
    expect(effects).toHaveBeenCalledOnce()
    expect(newExecute).not.toHaveBeenCalled()
    const entries = await history(await reopened.root(context))
    expect(entries.find((entry) => entry.kind === "pi.tool-result")?.model?.[0]).toMatchObject({
      role: "toolResult",
      isError: true,
    })
    expect((await reopened.inspect(context)).tasks).toEqual([])
  })
})
