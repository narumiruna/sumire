import path from "node:path"
import type { PiSessionFactory } from "../agent/pi-session-factory.js"
import type { ChatSessionRegistry } from "../agent/session-registry.js"
import type { AdminConfig } from "./auth.js"
import { importLegacyModels } from "./import.js"
import type { McpAdmin } from "./mcp.js"
import { ProviderAdmin } from "./providers.js"
import { createAdminServer } from "./server.js"
import type { AdminStore } from "./store.js"

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
  let applying: Promise<void> | undefined
  const apply = () => {
    if (applying) return applying
    const work = (async () => {
      const revision = store.snapshot().revision
      try {
        await sessions.invalidatePolicies()
        await providers.validate(store.snapshot().policy)
        providers.install(store.snapshot().policy.providers)
        if (store.snapshot().revision !== revision)
          throw new Error("Settings changed during application")
        store.applied(revision, true)
      } catch {
        store.applied(revision, false)
        throw new Error("Settings could not be applied")
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
  // A failed application must not prevent the administrator from repairing settings.
  await apply().catch(() => {})
  for (const id of await factory.listChats())
    store.observe(id, id > 0 ? "private" : "group", String(id))
  const server = createAdminServer(config, {
    store,
    mcp,
    providers,
    apply,
    tools: () => factory.toolNames ?? [],
  })
  await server.start()
  return server
}
