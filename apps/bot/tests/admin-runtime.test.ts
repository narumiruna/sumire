import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { importLegacyModels, readLegacySelection } from "../src/admin/import.js"
import { McpAdmin } from "../src/admin/mcp.js"
import { ProviderAdmin } from "../src/admin/providers.js"
import { McpProcessHomes } from "../src/agent/mcp-process-homes.js"
import { asSessionCreator, ChatSessionRegistry } from "../src/agent/session-registry.js"
import { loadSettings } from "../src/config/settings.js"
import { TestAdminStore as AdminStore } from "./helpers/admin-store.js"
import { callDurableTool } from "./helpers/durable-session.js"
import { createTestSessionFactory as createPiSessionFactory } from "./helpers/session-factory.js"

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function setup() {
  vi.stubEnv("OPENAI_API_KEY", "fixture-key")
  const root = await mkdtemp(path.join(os.tmpdir(), "sumire-admin-runtime-"))
  roots.push(root)
  await cp(path.resolve("../../instructions"), path.join(root, "instructions"), { recursive: true })
  await writeFile(path.join(root, "mcp.json"), '{"mcpServers":{}}')
  return { root, settings: loadSettings({ BOT_ADMIN_ID: "42" }, root, root) }
}

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("admin durable runtime integration", () => {
  it.each(["corrupt", "missing"])("ignores a %s legacy MCP source after import", async (state) => {
    const { root, settings } = await setup()
    const store = new AdminStore(path.join(root, "admin.sqlite"), new Set([42]), 42)
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
    const store = new AdminStore(path.join(root, ".telegramagent/admin.sqlite"), new Set([42]), 42)
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
  it("reports unsupported legacy thinking without poisoning the shared policy", async () => {
    const { root, settings } = await setup()
    const factory = await createPiSessionFactory(settings, logger)
    for (const id of [42, 43]) {
      const session = await factory.create(id)
      await session.appendPassiveContext("No model turn")
      await session.setThinkingLevel(id === 42 ? "low" : "high")
      await session.dispose()
    }
    const runtime = factory.modelRuntime as NonNullable<typeof factory.modelRuntime>
    const physical = runtime.getPhysicalModel.bind(runtime)
    vi.spyOn(runtime, "getPhysicalModel").mockImplementation((provider, id) => {
      const model = physical(provider, id)
      return model
        ? { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, low: null } }
        : undefined
    })
    const store = new AdminStore(path.join(root, "admin.sqlite"), new Set([42]), 42)
    try {
      await importLegacyModels(store, settings.botSessionLogDir, runtime)
      const state = store.snapshot()
      expect(state.policy.models).toEqual(["openai/gpt-6.1-sol"])
      expect(Object.keys(state.policy.chats)).toEqual(["43"])
      expect(state.policy.chats["43"]).toMatchObject({ thinking: "high" })
      await expect(
        new ProviderAdmin(runtime, store).validate(state.policy),
      ).resolves.toBeUndefined()
      const row = store.db.prepare("SELECT report FROM imports WHERE name='models'").get() as {
        report: string
      }
      expect(JSON.parse(row.report)).toMatchObject({ imported: 1, failedChatIds: [42] })
      store.applied(state.revision, true)
      expect(store.allows(42)).toBe(true)
      await importLegacyModels(store, settings.botSessionLogDir, runtime)
      expect(store.snapshot().policy).toEqual(state.policy)
    } finally {
      store.close()
    }
  })

  it.each(["chat", "server", "configuration"])(
    "does not start stale MCP commands when %s permission changes during creation",
    async (revoked) => {
      const { root, settings } = await setup()
      const store = new AdminStore(path.join(root, "admin.sqlite"), new Set([42]), 42)
      const mcp = new McpAdmin(store, root)
      const marker = path.join(root, "started")
      mcp.save(
        "fixture",
        {
          command: process.execPath,
          args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started")`],
        },
        1,
        "42",
      )
      const policy = store.snapshot().policy
      policy.models = ["openai/gpt-6.1-sol"]
      policy.defaults.models = [...policy.models]
      policy.defaults.model = policy.models[0] as string
      policy.servers = ["fixture"]
      policy.defaults.servers = ["fixture"]
      store.save(policy, 2, "42")
      store.applied(3, true)
      const factory = await createPiSessionFactory(settings, logger, undefined, undefined, {
        store,
        mcp,
      })
      const entered = deferred()
      const release = deferred()
      const createHome = McpProcessHomes.prototype.create
      vi.spyOn(McpProcessHomes.prototype, "create").mockImplementation(async function (
        this: McpProcessHomes,
      ) {
        entered.resolve()
        await release.promise
        return createHome.call(this)
      })
      const creation = factory.create(42)
      const rejected = expect(creation).rejects.toThrow("policy")
      try {
        await entered.promise
        const changed = store.snapshot().policy
        if (revoked === "chat") changed.privateUsers = []
        else if (revoked === "server") {
          changed.servers = []
          changed.defaults.servers = []
        }
        const revision = store.snapshot().revision
        if (revoked === "configuration") mcp.save("fixture", { enabled: false }, revision, "42")
        else store.save(changed, revision, "42")
        store.applied(revision + 1, true)
      } finally {
        release.resolve()
        await rejected
        expect(existsSync(marker)).toBe(false)
        await mcp.close()
        store.close()
      }
    },
  )

  it("guards saved tool references after revocation and preserves chat settings on reset", async () => {
    const { root, settings } = await setup()
    const store = new AdminStore(path.join(root, ".telegramagent/admin.sqlite"), new Set([42]), 42)
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
    expect(session.getActiveToolNames()).toContain("read")
    const file = path.join(root, "fixture.txt")
    await writeFile(file, "fixture content")
    expect(await callDurableTool(session, "read", { path: file })).toMatchObject({
      content: expect.any(Array),
      isError: false,
    })
    const changed = store.snapshot().policy
    changed.tools = []
    changed.defaults.tools = []
    const revoked = store.save(changed, store.snapshot().revision, "42")
    store.applied(revoked.revision, true)
    expect(await callDurableTool(session, "read", { path: file })).toMatchObject({ isError: true })
    await session.dispose()
    const registry = new ChatSessionRegistry(
      asSessionCreator(factory),
      settings.botSessionLogDir,
      logger,
      { control: store },
    )
    try {
      const state = store.snapshot()
      state.policy.chats["42"] = {
        enabled: true,
        skills: null,
        tools: null,
        servers: null,
        models: null,
        model: null,
        thinking: "low",
      }
      const changed = store.save(state.policy, state.revision, "42")
      await registry.invalidatePolicies()
      store.applied(changed.revision, true)
      const saved = store.snapshot().policy.chats["42"]
      expect(saved?.thinking).toBe("low")
      await registry.reset(42)
      expect(store.snapshot().policy.chats["42"]).toEqual(saved)
      const restored = await factory.create(42)
      expect(restored.thinkingLevel).toBe("low")
      await restored.dispose()
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
