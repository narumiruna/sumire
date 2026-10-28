import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { request } from "node:http"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { createPolicyApplier } from "../src/admin/application.js"
import { McpAdmin } from "../src/admin/mcp.js"
import { ProviderAdmin } from "../src/admin/providers.js"
import { RuntimeConfigAdmin } from "../src/admin/runtime-config.js"
import { createAdminServer } from "../src/admin/server.js"
import type { DurableSession } from "../src/agent/durable/session.js"
import { McpCapability } from "../src/agent/mcp-capability.js"
import { McpProcessHomes } from "../src/agent/mcp-process-homes.js"
import { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { TestAdminStore } from "./helpers/admin-store.js"
import { createPiFixture, toolResultText } from "./helpers/pi-fixture.js"
import { createTestSessionFactory } from "./helpers/session-factory.js"

const fixturePath = new URL("./fixtures/mcp-server.mjs", import.meta.url).pathname
const reference = (name: string) => `\${${name}}`
const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-runtime-mcp-"))
  const store = new TestAdminStore(path.join(directory, "admin.sqlite"), new Set([42]), 42)
  const runtime = new RuntimeConfigAdmin(store, Buffer.alloc(32, 7).toString("base64"))
  const mcp = new McpAdmin(store, directory, runtime)
  cleanups.push(async () => {
    await mcp.close()
    store.close()
    await rm(directory, { recursive: true, force: true })
  })
  store.applied(1, true)
  return { directory, store, runtime, mcp }
}

it("resolves only explicit per-server bindings and preserves empty and literal variable values", async () => {
  const { directory, store, runtime, mcp } = await setup()
  const metadata = { revision: 1, updatedAt: 1 }
  runtime.values.setSecret("FIRST_KEY", "synthetic-first-key", metadata)
  runtime.values.setSecret("SECOND_KEY", "synthetic-second-key", metadata)
  runtime.values.setSecret("UNRELATED_KEY", "synthetic-unrelated-key", metadata)
  runtime.values.setSecret("DISABLED_KEY", "synthetic-disabled-key", metadata)
  runtime.values.setVariable("EMPTY", "", metadata)
  const literal = `  \${UNRELATED_KEY} $(false)\n`
  runtime.values.setVariable("LITERAL", literal, metadata)
  runtime.values.setVariable("NODE_OPTIONS", "--invalid-managed-option", metadata)
  vi.stubEnv("AMBIENT_KEY", "synthetic-ambient-key")
  vi.stubEnv("BOT_TOKEN", "synthetic-bootstrap-token")
  const readSecret = vi.spyOn(runtime, "readSecret")
  const readVariable = vi.spyOn(runtime, "readVariable")
  mcp.save(
    "first",
    {
      command: reference("UNRELATED_KEY"),
      args: [reference("UNRELATED_KEY")],
      cwd: reference("UNRELATED_KEY"),
      env: {
        SECRET_KEY: reference("FIRST_KEY"),
        BLANK: reference("EMPTY"),
        TEXT: reference("LITERAL"),
        INLINE: "legacy-inline",
      },
    },
    1,
    "42",
  )
  mcp.save(
    "second",
    {
      url: `https://mcp.example.test/${reference("UNRELATED_KEY")}`,
      headers: {
        Authorization: `Bearer ${reference("SECOND_KEY")}`,
        "X-Empty": reference("EMPTY"),
      },
    },
    2,
    "42",
  )
  mcp.save(
    "ambient",
    { command: process.execPath, env: { TOKEN: reference("AMBIENT_KEY") } },
    3,
    "42",
  )
  mcp.save(
    "disabled",
    { command: process.execPath, enabled: false, env: { TOKEN: reference("DISABLED_KEY") } },
    4,
    "42",
  )
  store.applied(5, true)
  const config = mcp.config()
  expect(config.servers.map((server) => server.name)).toEqual(["first", "second"])
  expect(config.servers[0]).toMatchObject({
    command: reference("UNRELATED_KEY"),
    args: [reference("UNRELATED_KEY")],
    cwd: reference("UNRELATED_KEY"),
    env: { SECRET_KEY: "synthetic-first-key", BLANK: "", TEXT: literal, INLINE: "legacy-inline" },
    headers: {},
  })
  expect(config.servers[0]?.env).toEqual({
    SECRET_KEY: "synthetic-first-key",
    BLANK: "",
    TEXT: literal,
    INLINE: "legacy-inline",
  })
  expect(config.servers[1]).toMatchObject({
    url: `https://mcp.example.test/${reference("UNRELATED_KEY")}`,
    headers: { Authorization: "Bearer synthetic-second-key", "X-Empty": "" },
    env: {},
  })
  for (const name of ["UNRELATED_KEY", "NODE_OPTIONS", "DISABLED_KEY", "BOT_TOKEN"]) {
    expect(readSecret).not.toHaveBeenCalledWith(name)
    expect(readVariable).not.toHaveBeenCalledWith(name)
  }
  expect(mcp.references("DISABLED_KEY")).toEqual(["disabled"])
  expect(mcp.references("SECOND_KEY")).toEqual(["second"])
  expect(mcp.references("UNRELATED_KEY")).toEqual([])
  expect(process.env.NODE_OPTIONS).not.toBe("--invalid-managed-option")
  expect(process.env.FIRST_KEY).toBeUndefined()
  const withoutReader = new McpAdmin(store, directory)
  expect(withoutReader.config().servers).toEqual([])
  expect(JSON.stringify(mcp.inventory())).not.toContain("synthetic-")
})

it("keeps unresolved saved references and refreshes snapshots after key addition, rotation, and deletion", async () => {
  const { store, runtime, mcp } = await setup()
  vi.stubEnv("MANAGED_KEY", "synthetic-legacy-key")
  mcp.save(
    "bound",
    { command: process.execPath, env: { SECRET_KEY: reference("MANAGED_KEY") } },
    1,
    "42",
  )
  mcp.save("healthy", { command: process.execPath }, 2, "42")
  store.applied(3, true)
  expect(mcp.references("MANAGED_KEY")).toEqual(["bound"])
  expect(mcp.config().servers.map((server) => server.name)).toEqual(["healthy"])
  const policy = store.snapshot().policy
  runtime.save("MANAGED_KEY", { revision: 3, kind: "secret", value: "synthetic-old-key" }, "42")
  expect(store.snapshot().status).toBe("pending")
  expect(mcp.config().servers.map((server) => server.name)).toEqual(["healthy"])
  store.applied(4, true)
  const old = mcp.config()
  expect(old.servers[0]?.env.SECRET_KEY).toBe("synthetic-old-key")
  runtime.save("MANAGED_KEY", { revision: 4, kind: "secret", value: "synthetic-new-key" }, "42")
  store.applied(5, true)
  const fresh = mcp.config()
  expect(fresh.servers[0]?.env.SECRET_KEY).toBe("synthetic-new-key")
  expect(old.servers[0]?.env.SECRET_KEY).toBe("synthetic-old-key")
  expect(old.redact("synthetic-old-key")).toBe("[redacted]")
  // Reference-aware deletion is enforced by the management route. Seed a consumer deletion here.
  runtime.remove("MANAGED_KEY", 5, "42")
  store.applied(6, true)
  expect(mcp.config().servers.map((server) => server.name)).toEqual(["healthy"])
  expect(mcp.raw().bound?.env?.SECRET_KEY).toBe(reference("MANAGED_KEY"))
  expect(store.snapshot().policy).toEqual(policy)
})

it.each(["pending", "failed"])(
  "rejects probes while application is %s without starting a transport",
  async (status) => {
    const { store, mcp } = await setup()
    mcp.save("fixture", { command: process.execPath, args: [fixturePath] }, 1, "42")
    if (status === "failed") store.applied(2, false)
    const createHome = vi.spyOn(McpProcessHomes.prototype, "create")
    await expect(mcp.discover("fixture")).rejects.toMatchObject({ status: 409 })
    expect(createHome).not.toHaveBeenCalled()
    expect(mcp.probes.size).toBe(0)
    expect(mcp.discovered.size).toBe(0)
  },
)

it("does not start a probe transport from an old authorization epoch", async () => {
  const { directory, store, mcp } = await setup()
  const trace = path.join(directory, "epoch-list-trace")
  mcp.save(
    "fixture",
    {
      command: process.execPath,
      args: [fixturePath],
      env: { MCP_TEST_LIST_TRACE: trace },
    },
    1,
    "42",
  )
  store.applied(2, true)
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const original = McpProcessHomes.prototype.create
  const createHome = vi
    .spyOn(McpProcessHomes.prototype, "create")
    .mockImplementation(async function (this: McpProcessHomes) {
      const home = await original.call(this)
      await gate
      return home
    })
  const probe = mcp.discover("fixture")
  try {
    await vi.waitFor(() => expect(createHome).toHaveBeenCalledOnce())
    const state = store.snapshot()
    store.save(state.policy, state.revision, "42")
    store.applied(store.snapshot().revision, true)
    release()
    expect((await probe).tools).toEqual([])
    await expect(readFile(trace, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(mcp.probes.size).toBe(0)
  } finally {
    release()
    await probe.catch(() => {})
  }
})

it("blocks runtime mutations during a real local probe, then resolves the next probe from fresh values", async () => {
  const { directory, store, runtime, mcp } = await setup()
  runtime.values.setSecret("MANAGED_KEY", "synthetic-probe-key", { revision: 1, updatedAt: 1 })
  const trace = path.join(directory, "list-trace")
  const gate = path.join(directory, "list-gate")
  mcp.save(
    "fixture",
    {
      command: process.execPath,
      args: [fixturePath],
      env: {
        SECRET_KEY: reference("MANAGED_KEY"),
        MCP_TEST_LIST_TRACE: trace,
        MCP_TEST_LIST_GATE: gate,
      },
    },
    1,
    "42",
  )
  store.applied(2, true)
  const apply = vi.fn(async () => store.applied(store.snapshot().revision, true))
  const server = createAdminServer(
    { origin: "https://admin.example.test", host: "127.0.0.1", port: 0, assets: directory },
    {
      store,
      runtime,
      mcp,
      apply,
      providers: new ProviderAdmin({} as never, store),
      tools: () => [],
    },
  )
  await server.start()
  const session = store.createSession("42")
  const address = server.server.address()
  if (!address || typeof address === "string") throw new Error("Missing local API address")
  const probe = mcp.discover("fixture")
  try {
    await vi.waitFor(async () => expect(await readFile(trace, "utf8")).toBe("list\n"), {
      timeout: 5000,
    })
    const before = store.snapshot()
    for (const [method, name] of [
      ["PUT", "MANAGED_KEY"],
      ["PUT", "NEW_VARIABLE"],
      ["DELETE", "MANAGED_KEY"],
    ]) {
      const body = JSON.stringify(
        method === "DELETE"
          ? { revision: 2 }
          : {
              revision: 2,
              kind: name === "NEW_VARIABLE" ? "variable" : "secret",
              value: "synthetic-replacement",
            },
      )
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path: `/api/runtime-config/${name}`,
            method,
            headers: {
              host: "admin.example.test",
              origin: "https://admin.example.test",
              cookie: `__Host-sumire-session=${session.value}`,
              "x-csrf-token": session.csrf,
              "content-type": "application/json",
              "content-length": String(Buffer.byteLength(body)),
            },
          },
          (res) => {
            let body = ""
            res.on("data", (chunk) => {
              body += chunk
            })
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
          },
        )
        req.on("error", reject)
        req.end(body)
      })
      expect(response.status, response.body).toBe(409)
      expect(response.body).not.toContain("synthetic-")
    }
    expect(store.snapshot()).toEqual(before)
    expect(runtime.readSecret("MANAGED_KEY")).toBe("synthetic-probe-key")
    expect(runtime.readVariable("NEW_VARIABLE")).toBeUndefined()
    expect(apply).not.toHaveBeenCalled()
    await writeFile(gate, "ready")
    expect((await probe).tools).toContain("mcp__fixture__echo")
    expect(mcp.probes.size).toBe(0)
    runtime.save(
      "MANAGED_KEY",
      { revision: store.snapshot().revision, kind: "secret", value: "synthetic-replacement" },
      "42",
    )
    await expect(mcp.discover("fixture")).rejects.toMatchObject({ status: 409 })
    store.applied(store.snapshot().revision, true)
    expect(mcp.config().servers[0]?.env.SECRET_KEY).toBe("synthetic-replacement")
    expect((await mcp.discover("fixture")).tools).toContain("mcp__fixture__echo")
  } finally {
    await writeFile(gate, "ready")
    await probe.catch(() => {})
    await server.stop()
  }
})

it.each(["replace", "delete"])(
  "retains the dispatched connection's redactor during key %s and closes old handles",
  async (operation) => {
    const { directory, store, runtime, mcp } = await setup()
    const oldKey = "synthetic-inflight-old-key"
    runtime.values.setSecret("MANAGED_KEY", oldKey, { revision: 1, updatedAt: 1 })
    mcp.save(
      "fixture",
      {
        command: process.execPath,
        args: [fixturePath],
        env: { SECRET_KEY: reference("MANAGED_KEY") },
      },
      1,
      "42",
    )
    store.applied(2, true)
    const logger = { warn: vi.fn() }
    const capability = new McpCapability(
      mcp.config(),
      directory,
      path.join(directory, "capability"),
      logger,
      () => {},
    )
    try {
      await capability.ready()
      const echo = capability.tools.find((tool) => tool.name === "mcp__fixture__echo")
      if (!echo) throw new Error("Missing fixture echo")
      expect(JSON.stringify(capability.tools)).not.toContain(oldKey)
      const result = echo.execute(
        "inflight",
        { returnSecret: true },
        undefined,
        undefined,
        undefined as never,
      )
      if (operation === "replace")
        runtime.save(
          "MANAGED_KEY",
          { revision: 2, kind: "secret", value: "synthetic-inflight-new-key" },
          "42",
        )
      else runtime.remove("MANAGED_KEY", 2, "42")
      store.applied(3, true)
      expect(mcp.config().servers[0]?.env.SECRET_KEY).toBe(
        operation === "replace" ? "synthetic-inflight-new-key" : undefined,
      )
      const completed = await result
      expect(JSON.stringify(completed)).toContain("[redacted]")
      expect(JSON.stringify(completed)).not.toContain(oldKey)
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(oldKey)
      await capability.close()
      expect(capability.tools).toEqual([])
      await expect(
        echo.execute("stale", {}, undefined, undefined, undefined as never),
      ).rejects.toThrow("no longer available")
      expect(
        (await readdir(path.join(directory, "capability"))).filter((name) =>
          name.startsWith("process-"),
        ),
      ).toEqual([])
    } finally {
      await capability.close()
    }
  },
)

it("activates a previously unresolved server without automatically granting its discovered tools", async () => {
  const { store, runtime, mcp } = await setup()
  mcp.save(
    "fixture",
    { command: process.execPath, args: [fixturePath], env: { SECRET_KEY: reference("NEW_KEY") } },
    1,
    "42",
  )
  const state = store.snapshot()
  state.policy.servers = ["fixture"]
  state.policy.defaults.servers = ["fixture"]
  store.save(state.policy, state.revision, "42")
  store.applied(store.snapshot().revision, true)
  await expect(mcp.discover("fixture")).rejects.toThrow("disabled or invalid")
  const grants = store.snapshot().policy
  runtime.save(
    "NEW_KEY",
    { revision: store.snapshot().revision, kind: "secret", value: "activation-key-sentinel" },
    "42",
  )
  store.applied(store.snapshot().revision, true)
  const discovered = await mcp.discover("fixture")
  expect(discovered.tools).toContain("mcp__fixture__echo")
  expect(store.snapshot().policy).toEqual(grants)
  expect(store.allowsTool(42, "mcp__fixture__echo", "fixture")).toBe(false)
  expect(JSON.stringify(mcp.inventory())).not.toContain("activation-key-sentinel")
})

it("retains 513 probe tools without granting them or rejecting a valid directory", async () => {
  const { store, mcp } = await setup()
  const tools = Array.from({ length: 513 }, (_, index) => `tool_${index}`)
  mcp.save(
    "bulk",
    { command: process.execPath, args: [fixturePath], env: { MCP_TEST_TOOLS: tools.join(",") } },
    1,
    "42",
  )
  store.applied(store.snapshot().revision, true)
  const before = store.snapshot()
  const result = await mcp.discover("bulk")
  expect(result.tools).toHaveLength(513)
  expect(store.snapshot()).toEqual(before)
})

it("retains an explicitly approved runtime tool in a 513-tool discovery directory", async () => {
  const fixture = await createPiFixture()
  cleanups.push(() => fixture.cleanup())
  const store = fixture.factory.control
  const runtime = fixture.factory.runtime
  const mcp = new McpAdmin(store, fixture.root, runtime)
  cleanups.push(() => mcp.close())
  const tools = Array.from({ length: 513 }, (_, index) => `tool_${index}`)
  mcp.save(
    "bulk",
    {
      command: process.execPath,
      args: [fixturePath],
      exposure: "direct",
      env: { MCP_TEST_TOOLS: tools.join(",") },
    },
    store.snapshot().revision,
    "7",
  )
  const state = store.snapshot()
  state.policy.servers = ["bulk"]
  state.policy.defaults.servers = ["bulk"]
  state.policy.tools.push("mcp__bulk__tool_0")
  state.policy.defaults.tools?.push("mcp__bulk__tool_0")
  store.save(state.policy, state.revision, "7")
  store.applied(store.snapshot().revision, true)
  const factory = await createTestSessionFactory(
    fixture.settings,
    fixture.logger,
    undefined,
    fixture.modelRuntime,
    { store, mcp, runtime },
  )
  const before = store.snapshot().policy
  const session = await factory.create(123)
  cleanups.push(() => session.dispose())
  expect(session.getActiveToolNames()).toContain("mcp__bulk__tool_0")
  expect(session.getActiveToolNames()).not.toContain("mcp__bulk__tool_1")
  expect(store.snapshot().policy).toEqual(before)
})

async function assertNoSecrets(directory: string, secrets: string[]) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) await assertNoSecrets(file, secrets)
    else {
      const bytes = await readFile(file)
      for (const secret of secrets) expect(bytes.includes(Buffer.from(secret)), file).toBe(false)
    }
  }
}

it("applies key rotation by closing durable MCP sessions without replaying an interrupted side effect", async () => {
  const fixture = await createPiFixture()
  cleanups.push(() => fixture.cleanup())
  const store = fixture.factory.control
  const runtime = fixture.factory.runtime
  if (!runtime) throw new Error("Missing fixture runtime reader")
  const oldKey = "synthetic-durable-old-key"
  const newKey = "synthetic-durable-new-key"
  runtime.values.setSecret("MANAGED_KEY", oldKey, { revision: 1, updatedAt: 1 })
  const mcp = new McpAdmin(store, fixture.root, runtime)
  cleanups.push(() => mcp.close())
  const effects = path.join(fixture.root, "effects")
  mcp.save(
    "fixture",
    {
      command: process.execPath,
      args: [fixturePath, effects],
      exposure: "direct",
      env: { SECRET_KEY: reference("MANAGED_KEY") },
    },
    store.snapshot().revision,
    "7",
  )
  const state = store.snapshot()
  state.policy.servers = ["fixture"]
  state.policy.defaults.servers = ["fixture"]
  const names = ["echo", "hold", "environment"].map((name) => `mcp__fixture__${name}`)
  state.policy.tools.push(...names)
  state.policy.defaults.tools?.push(...names)
  store.save(state.policy, state.revision, "7")
  store.applied(store.snapshot().revision, true)
  const factory = await createTestSessionFactory(
    fixture.settings,
    fixture.logger,
    undefined,
    fixture.modelRuntime,
    { store, mcp, runtime },
  )
  const created: DurableSession[] = []
  const registry = new ChatSessionRegistry(
    async (chatId) => {
      const session = await factory.create(chatId)
      created.push(session)
      return session
    },
    fixture.settings.botSessionLogDir,
    fixture.logger,
    { control: store },
  )
  cleanups.push(() => registry.dispose())
  const apply = createPolicyApplier(store, registry, {
    validate: async () => {},
    install: () => {},
  })
  vi.stubEnv("BOT_TOKEN", "synthetic-ambient-bootstrap-token")
  const grantsBeforeDiscovery = store.snapshot().policy
  fixture.enqueue("mcp__fixture__echo", { returnSecret: true })
  await registry.submit(123, "Read the local fixture")
  expect(store.snapshot().policy).toEqual(grantsBeforeDiscovery)
  const first = created[0]
  if (!first) throw new Error("Missing first session")
  const retained = first.nativeTools.find((tool) => tool.name === "mcp__fixture__echo")
  if (!retained) throw new Error("Missing retained echo handle")
  expect(JSON.stringify(first.messages)).toContain("[redacted]")
  expect(JSON.stringify(first.nativeTools)).not.toContain(oldKey)
  const environment = await fixture.call(first, "mcp__fixture__environment", {})
  expect(toolResultText(environment)).toContain("absent")
  expect(JSON.stringify(environment)).not.toContain("synthetic-ambient-bootstrap-token")
  const mcpDirectory = path.join(fixture.settings.botSessionLogDir, "123", "durable", "mcp")
  const oldHomes = (await readdir(mcpDirectory)).filter((name) => name.startsWith("process-"))
  expect(oldHomes).toHaveLength(1)
  fixture.enqueue("mcp__fixture__hold", {}, false)
  const running = registry.submit(123, "Run one local side effect").catch(() => {})
  try {
    await vi.waitFor(async () => expect(await readFile(effects, "utf8")).toBe("called\n"), {
      timeout: 5000,
    })
    const policy = store.snapshot().policy
    runtime.save(
      "MANAGED_KEY",
      { revision: store.snapshot().revision, kind: "secret", value: newKey },
      "7",
    )
    expect(store.snapshot().status).toBe("pending")
    await apply()
    await running
    expect(store.snapshot().status).toBe("applied")
    expect(store.snapshot().policy).toEqual(policy)
    expect((await readdir(mcpDirectory)).filter((name) => name.startsWith("process-"))).toEqual([])
    await expect(
      retained.execute("stale", {}, undefined, undefined, undefined as never),
    ).rejects.toThrow()
    fixture.enqueue("mcp__fixture__echo", { returnSecret: true })
    await registry.submit(123, "Use the replacement connection")
    expect(created).toHaveLength(2)
    const second = created[1]
    if (!second) throw new Error("Missing replacement session")
    expect(JSON.stringify(second.messages)).toContain("[redacted]")
    expect(JSON.stringify(second.messages)).toContain("Read the local fixture")
    expect(JSON.stringify(second.messages)).toContain("mcp__fixture__hold")
    expect(await readFile(effects, "utf8")).toBe("called\n")
    const newHomes = (await readdir(mcpDirectory)).filter((name) => name.startsWith("process-"))
    expect(newHomes).toHaveLength(1)
    expect(newHomes).not.toContain(oldHomes[0])
    expect(mcp.config().servers[0]?.env.SECRET_KEY).toBe(newKey)
    for (const secret of [oldKey, newKey]) {
      expect(JSON.stringify(fixture.requests)).not.toContain(secret)
      expect(JSON.stringify(second.nativeTools)).not.toContain(secret)
      expect(JSON.stringify(second.messages)).not.toContain(secret)
      expect(JSON.stringify(store.listAudit(0))).not.toContain(secret)
    }
    await registry.dispose()
    await assertNoSecrets(fixture.settings.botSessionLogDir, [oldKey, newKey])
  } finally {
    await registry.dispose()
    await running
  }
}, 30_000)
