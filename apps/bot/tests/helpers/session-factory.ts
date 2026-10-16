import path from "node:path"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { McpAdmin } from "../../src/admin/mcp.js"
import type { AdminStore } from "../../src/admin/store.js"
import { createPiSessionFactory } from "../../src/agent/pi-session-factory.js"
import type { Settings } from "../../src/config/settings.js"
import type { Logger } from "../../src/logging.js"
import type { ChannelImageIndex } from "../../src/telegram/channel-images.js"
import type { TelegramMiyuNews } from "../../src/telegram/miyu-cna-news.js"
import { TestAdminStore } from "./admin-store.js"

export async function createTestSessionFactory(
  settings: Settings,
  logger: Logger,
  images?: ChannelImageIndex,
  runtime?: ModelRuntime,
  supplied?: { store: AdminStore; mcp: McpAdmin },
  miyuNews?: Pick<TelegramMiyuNews, "createTool">,
) {
  if (supplied)
    return {
      ...(await createPiSessionFactory(settings, logger, supplied, images, runtime, miyuNews)),
      control: supplied.store,
    }
  const store = new TestAdminStore(
    path.join(settings.projectRoot, "fixture-admin.sqlite"),
    new Set([7, 8, 42, 43, 123, 456, -100]),
    settings.botAdminId,
  )
  const mcp = new McpAdmin(store, settings.botWorkdir)
  await mcp.import(settings.botMcpConfigPath)
  const factory = await createPiSessionFactory(
    settings,
    logger,
    { store, mcp },
    images,
    runtime,
    miyuNews,
  )
  // The fixture explicitly approves a finite tool/model catalog, never arbitrary chat IDs.
  if (store.snapshot().policy.models.length === 0) {
    const policy = store.snapshot().policy
    policy.models = (factory.modelRuntime?.getModels() ?? [])
      .filter((m) => m.provider === "openai" || m.provider === "anthropic")
      .map((m) => `${m.provider}/${m.id}`)
      .slice(0, 512)
    policy.defaults.models = [...policy.models]
    policy.defaults.model = "openai/gpt-6.1-sol"
    policy.defaults.thinking = "low"
    policy.servers = mcp.config().servers.map((server) => server.name)
    policy.defaults.servers = [...policy.servers]
    // Approve the finite MCP fixture protocol, including tools used by replacement tests.
    const fixtureTools = ["echo", "error", "change_tools", "new_tool", "a_b", "ready", "hold"]
    policy.tools = [
      ...(factory.toolNames ?? []),
      ...policy.servers.flatMap((server) => fixtureTools.map((tool) => `mcp__${server}__${tool}`)),
    ]
    policy.defaults.tools = [...policy.tools]
    store.db.prepare("UPDATE settings SET policy=? WHERE id=1").run(JSON.stringify(policy))
    store.applied(store.snapshot().revision, true)
  }
  return { ...factory, control: store }
}
