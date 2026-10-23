import path from "node:path"
import type { PiSessionFactory } from "../agent/pi-session-factory.js"
import type { ChatSessionRegistry } from "../agent/session-registry.js"
import type { AdminConfig } from "./auth.js"
import { importLegacyModels } from "./import.js"
import type { McpAdmin } from "./mcp.js"
import { ProviderAdmin } from "./providers.js"
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

export async function startAdmin(
  config: AdminConfig,
  control: { store: AdminStore; mcp: McpAdmin },
  factory: PiSessionFactory,
  sessions: ChatSessionRegistry,
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
  const apply = createPolicyApplier(store, sessions, providers)
  // A failed application must not prevent the administrator from repairing settings.
  await apply().catch(() => {})
  for (const id of await factory.listChats())
    store.observe(id, id > 0 ? "private" : "group", String(id), "inferred")
  const server = createAdminServer(config, {
    store,
    mcp,
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
