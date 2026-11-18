import { mkdir } from "node:fs/promises"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { PiSessionFactory } from "../agent/pi-session-factory.js"
import type { ChatSessionRegistry } from "../agent/session-registry.js"
import { IssueAnalysisRuntime } from "../issues/runtime.js"
import type { AdminConfig } from "./auth.js"
import type { GitHubAuth } from "./github-auth.js"
import { importLegacyModels } from "./import.js"
import type { McpAdmin } from "./mcp.js"
import { ProviderAdmin } from "./providers.js"
import type { RuntimeConfigAdmin } from "./runtime-config.js"
import { createAdminServer } from "./server.js"
import type { AdminStore } from "./store.js"

export function createPolicyApplier(
  store: AdminStore,
  sessions: Pick<ChatSessionRegistry, "invalidatePolicies">,
  providers: Pick<ProviderAdmin, "validate" | "install">,
) {
  let applying: Promise<void> | undefined
  return () => {
    if (applying) return applying
    const work = (async () => {
      for (;;) {
        const { revision, policy } = store.snapshot()
        try {
          await sessions.invalidatePolicies()
          await providers.validate(policy)
          if (store.snapshot().revision !== revision) continue
          providers.install(policy.providers)
          store.applied(revision, true)
          return
        } catch {
          if (store.snapshot().revision !== revision) continue
          store.applied(revision, false)
          throw new Error("Settings could not be applied")
        }
      }
    })()
    applying = work
    void work
      .finally(() => {
        if (applying === work) applying = undefined
      })
      .catch(() => {})
    return work
  }
}

interface AdminControl {
  store: AdminStore
  mcp: McpAdmin
  runtime?: RuntimeConfigAdmin
  github?: GitHubAuth
}

export async function startAdmin(
  config: AdminConfig,
  control: AdminControl,
  factory: PiSessionFactory,
  sessions: ChatSessionRegistry,
) {
  const directory = path.join(path.dirname(control.store.file), "issues")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  // A separate SQLite file gives the worker a process-lifetime lock without locking AdminStore.
  const owner = new DatabaseSync(path.join(directory, ".owner.sqlite"), { timeout: 0 })
  try {
    owner.exec("BEGIN IMMEDIATE")
  } catch (cause) {
    owner.close()
    throw new Error("Could not acquire the issue analysis storage lock", { cause })
  }

  try {
    const server = await startOwnedAdmin(config, control, factory, sessions, directory)
    let stopping: Promise<void> | undefined
    return {
      ...server,
      stop() {
        stopping ??= server.stop().finally(() => owner.close())
        return stopping
      },
    }
  } catch (error) {
    owner.close()
    throw error
  }
}

async function startOwnedAdmin(
  config: AdminConfig,
  control: AdminControl,
  factory: PiSessionFactory,
  sessions: ChatSessionRegistry,
  directory: string,
) {
  if (!factory.modelRuntime) throw new Error("Admin requires a model runtime")
  const { store, mcp } = control
  await importLegacyModels(
    store,
    path.join(path.dirname(store.file), "sessions"),
    factory.modelRuntime,
  )
  const providers = new ProviderAdmin(factory.modelRuntime, store, async (provider) => {
    const latest = store.snapshot()
    store.save(
      latest.policy,
      latest.revision,
      String(store.adminId),
      "provider.oauth.complete",
      `provider:${provider}`,
    )
    await apply()
  })
  const applyPolicy = createPolicyApplier(store, sessions, providers)
  const apply = () => {
    mcp.discovered.clear()
    return applyPolicy()
  }
  // A failed application must not prevent the administrator from repairing settings.
  await apply().catch(() => {})
  for (const id of await factory.listChats())
    store.observe(id, id > 0 ? "private" : "group", String(id), "inferred")
  const analysis = new IssueAnalysisRuntime({
    store,
    runtime: factory.modelRuntime,
    directory,
  })
  const server = createAdminServer(config, {
    analysis,
    store,
    mcp,
    ...(control.runtime ? { runtime: control.runtime } : {}),
    ...(control.github ? { github: control.github } : {}),
    providers,
    apply,
    tools: () => factory.toolNames ?? [],
    toolAvailability: factory.toolAvailability?.bind(factory),
    skills: () => factory.skills,
    inspectDurable: (chatId, query, signal) => sessions.inspectDurable(chatId, query, signal),
  })
  await server.start()
  return server
}
