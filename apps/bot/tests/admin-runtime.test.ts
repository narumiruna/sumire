import { createHash } from "node:crypto"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { importLegacyModels, readLegacySelection } from "../src/admin/import.js"
import { McpAdmin } from "../src/admin/mcp.js"
import { AdminStore } from "../src/admin/store.js"
import { createPiSessionFactory } from "../src/agent/pi-session-factory.js"
import { asSessionCreator, ChatSessionRegistry } from "../src/agent/session-registry.js"
import { loadSettings } from "../src/config/settings.js"

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function setup() {
  vi.stubEnv("OPENAI_API_KEY", "fixture-key")
  const root = await mkdtemp(path.join(os.tmpdir(), "sumire-admin-runtime-"))
  roots.push(root)
  await cp(path.resolve("../../instructions"), path.join(root, "instructions"), { recursive: true })
  await writeFile(path.join(root, "mcp.json"), '{"mcpServers":{}}')
  return { root, settings: loadSettings({ BOT_WHITELIST: "42", BOT_ADMIN_ID: "42" }, root, root) }
}

describe("admin durable runtime integration", () => {
  it.each(["corrupt", "missing"])("ignores a %s legacy MCP source after import", async (state) => {
    const { root, settings } = await setup()
    const store = new AdminStore(path.join(root, "admin.sqlite"), settings.botWhitelist, 42)
    const mcp = new McpAdmin(store, settings.botWorkdir)
    try {
      await mcp.import(settings.botMcpConfigPath)
      if (state === "missing") await rm(settings.botMcpConfigPath)
      else await writeFile(settings.botMcpConfigPath, "{broken")
      await expect(mcp.import(settings.botMcpConfigPath)).resolves.toBeUndefined()
      await expect(
        createPiSessionFactory(settings, logger, undefined, undefined, { store, mcp }),
      ).resolves.toBeDefined()
      await expect(createPiSessionFactory(settings, logger)).rejects.toThrow()
    } finally {
      await mcp.close()
      store.close()
    }
  })

  it("imports model selections through a consistent copy without changing session data", async () => {
    const { root, settings } = await setup()
    const factory = await createPiSessionFactory(settings, logger)
    const session = await factory.create(42)
    await session.setThinkingLevel("low")
    await session.dispose()
    const file = path.join(settings.botSessionLogDir, "42/durable/session.sqlite")
    const hash = async () =>
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex")
    const before = await hash()
    expect(await readLegacySelection(file)).toEqual({
      model: "openai/gpt-6.1-sol",
      thinking: "low",
    })
    const store = new AdminStore(
      path.join(root, ".telegramagent/admin.sqlite"),
      settings.botWhitelist,
      42,
    )
    try {
      await importLegacyModels(
        store,
        settings.botSessionLogDir,
        factory.modelRuntime as NonNullable<typeof factory.modelRuntime>,
      )
      expect(store.snapshot().policy.chats["42"]).toMatchObject({
        model: "openai/gpt-6.1-sol",
        thinking: "low",
        tools: null,
      })
      const first = store.snapshot().policy
      await importLegacyModels(
        store,
        settings.botSessionLogDir,
        factory.modelRuntime as NonNullable<typeof factory.modelRuntime>,
      )
      expect(store.snapshot().policy).toEqual(first)
      expect(await hash()).toBe(before)
    } finally {
      store.close()
    }
  })
  it("guards saved tool references after revocation and preserves chat settings on reset", async () => {
    const { root, settings } = await setup()
    const store = new AdminStore(
      path.join(root, ".telegramagent/admin.sqlite"),
      settings.botWhitelist,
      42,
    )
    const mcp = new McpAdmin(store, settings.botWorkdir)
    const policy = store.snapshot().policy
    policy.models = ["openai/gpt-6.1-sol"]
    policy.defaults.models = [...policy.models]
    policy.defaults.model = policy.models[0] as string
    policy.tools = ["read"]
    policy.defaults.tools = ["read"]
    store.save(policy, 1, "42")
    store.applied(2, true)
    const factory = await createPiSessionFactory(settings, logger, undefined, undefined, {
      store,
      mcp,
    })
    const session = await factory.create(42)
    const read = session.nativeTools.find((tool) => tool.name === "read")
    expect(read).toBeDefined()
    const file = path.join(root, "fixture.txt")
    await writeFile(file, "fixture content")
    expect(
      await read?.execute("read-1", { path: file }, undefined, undefined, undefined as never),
    ).toMatchObject({ content: expect.any(Array) })
    const changed = store.snapshot().policy
    changed.tools = []
    changed.defaults.tools = []
    store.save(changed, 2, "42")
    store.applied(3, true)
    expect(() =>
      read?.execute("read-2", { path: file }, undefined, undefined, undefined as never),
    ).toThrow("not allowed")
    await session.dispose()
    const registry = new ChatSessionRegistry(
      asSessionCreator(factory),
      settings.botSessionLogDir,
      logger,
      { control: store },
    )
    try {
      await registry.setThinkingLevel(42, "low")
      const saved = store.snapshot().policy.chats["42"]
      expect(saved?.thinking).toBe("low")
      await registry.reset(42)
      expect(store.snapshot().policy.chats["42"]).toEqual(saved)
      expect((await registry.getModelSettings(42)).thinkingLevel).toBe("low")
      const before = await readFile(
        path.join(settings.botSessionLogDir, "42/durable/session.sqlite"),
      )
      await registry.invalidatePolicies()
      expect(
        await readFile(path.join(settings.botSessionLogDir, "42/durable/session.sqlite")),
      ).not.toHaveLength(0)
      expect(before.length).toBeGreaterThan(0)
    } finally {
      await registry.dispose()
      store.close()
    }
  })
})
