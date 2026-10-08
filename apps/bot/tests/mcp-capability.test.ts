import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { StdioTransport, type Tool } from "@earendil-works/pi-mcp"
import { afterEach, describe, expect, it, vi } from "vitest"
import { McpCapability, mcpToolNames } from "../src/agent/mcp-capability.js"
import { loadMcpConfig } from "../src/agent/mcp-config.js"
import {
  MCP_MAX_IMAGE_BYTES,
  MCP_MAX_MESSAGE_BYTES,
  shapeMcpResult,
} from "../src/agent/mcp-results.js"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
const fixturePath = new URL("./fixtures/mcp-server.mjs", import.meta.url).pathname
async function setup(
  entries?: Record<string, unknown>,
  environment: NodeJS.ProcessEnv = {},
  beforeReady?: (capability: McpCapability) => Promise<void>,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-mcp-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, "mcp.json")
  await writeFile(
    file,
    JSON.stringify({
      mcpServers: entries ?? { fake: { command: process.execPath, args: [fixturePath] } },
    }),
  )
  const logger = { warn: vi.fn() }
  const config = await loadMcpConfig(
    { botMcpEnabled: true, botMcpConfigPath: file },
    logger,
    environment,
  )
  const changed = vi.fn()
  const capability = new McpCapability(
    config,
    directory,
    path.join(directory, "mcp"),
    logger,
    changed,
  )
  cleanup.push(() => capability.close())
  await beforeReady?.(capability)
  await capability.ready()
  const call = async (name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) => {
    const tool = capability.tools.find((tool) => tool.name.endsWith(`__${name}`))
    if (!tool) throw new Error(`Missing ${name}`)
    return tool.execute("test-call", args, signal, undefined, undefined as never)
  }
  return { capability, call, directory, logger, changed, config }
}

describe("MCP capability", () => {
  it("uses real stdio, preserves structured content and errors, and exposes namespace instructions", async () => {
    const { capability, call } = await setup()
    expect(capability.tools[0]).toMatchObject({
      exposure: "deferred",
      namespace: { name: "mcp__fake", instructions: "Use echo for testing" },
    })
    expect(capability.summary()).toContain("Discover with codemode")
    expect(await call("echo", { text: "hello" })).toMatchObject({
      structuredContent: {
        content: [{ type: "text" }],
        structuredContent: { args: { text: "hello" } },
      },
      isError: false,
    })
    expect(await call("error")).toMatchObject({
      structuredContent: { isError: true, structuredContent: { reason: "test" } },
      isError: true,
    })
    expect(await call("image")).toMatchObject({ content: [{ type: "image", data: "aGVsbG8=" }] })
    expect(await call("binary")).toMatchObject({
      structuredContent: { content: [{ type: "audio" }] },
    })
  })

  it("dispatches real stdio tools with fractional-second deadlines", async () => {
    const { call } = await setup({
      fake: { command: process.execPath, args: [fixturePath], timeout: 1.2345 },
    })
    expect(await call("echo")).toMatchObject({ isError: false })
  })

  it("isolates process homes per chat and does not inherit bot credentials", async () => {
    vi.stubEnv("BOT_TOKEN", "must-not-inherit")
    try {
      const first = await setup()
      const second = await setup()
      const a = await first.call("environment")
      const b = await second.call("environment")
      expect(JSON.stringify(a)).toContain("absent")
      expect(JSON.stringify(a)).not.toContain("must-not-inherit")
      expect(a.content).not.toEqual(b.content)
      await first.capability.close()
      expect(second.capability.tools.length).toBeGreaterThan(0)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("updates the directory and rejects withdrawn tools held by old snapshots", async () => {
    const { capability, call } = await setup()
    const old = capability.tools.find((tool) => tool.name.endsWith("__echo"))
    if (!old) throw new Error("Missing echo tool")
    await call("change_tools")
    await vi.waitFor(() =>
      expect(capability.tools.some((tool) => tool.name.endsWith("__new_tool"))).toBe(true),
    )
    expect(capability.tools.some((tool) => tool.name.endsWith("__echo"))).toBe(false)
    await expect(
      old.execute("stale", {}, undefined, undefined, undefined as never),
    ).rejects.toThrow("no longer available")
  })

  it("rejects old wrappers when a replacement reuses the normalized public name", async () => {
    const { capability, call } = await setup({
      fake: {
        command: process.execPath,
        args: [fixturePath],
        env: { MCP_TEST_TOOLS: "a-b,change_tools" },
      },
    })
    const old = capability.tools.find((tool) => tool.name === "mcp__fake__a_b")
    if (!old) throw new Error("Missing initial wrapper")
    await call("change_tools", { names: ["a_b", "change_tools"] })
    await vi.waitFor(() =>
      expect(capability.tools.find((tool) => tool.name === old.name)).not.toBe(old),
    )
    await expect(
      old.execute("stale", {}, undefined, undefined, undefined as never),
    ).rejects.toThrow("no longer available")
    const replacement = capability.tools.find((tool) => tool.name === old.name)
    expect(
      await replacement?.execute("new", {}, undefined, undefined, undefined as never),
    ).toMatchObject({ isError: false })
  })

  it("uses an opaque public alias but dispatches the unchanged credential-colliding raw name", async () => {
    const { capability } = await setup({
      fake: {
        command: process.execPath,
        args: [fixturePath],
        exposure: "hidden",
        toolExposure: { echo: "direct" },
        env: { SECRET_KEY: "echo" },
      },
    })
    expect(capability.tools).toHaveLength(1)
    const tool = capability.tools[0]
    if (!tool) throw new Error("Missing alias")
    expect(tool.name).toMatch(/^mcp__fake__tool_[a-f0-9]{8}$/)
    expect(JSON.stringify(capability.tools)).not.toContain("echo")
    expect(
      await tool.execute("alias", { value: "hello" }, undefined, undefined, undefined as never),
    ).toMatchObject({
      isError: false,
      structuredContent: { structuredContent: { args: { value: "hello" } } },
    })
  })

  it("withholds credential-bearing structural schemas without exposing or changing them", async () => {
    const { capability, logger } = await setup({
      fake: {
        command: process.execPath,
        args: [fixturePath],
        env: {
          SECRET_KEY: "schema-secret",
          MCP_TEST_SCHEMA: JSON.stringify({
            type: "object",
            properties: { value: { enum: ["schema-secret"] } },
          }),
        },
      },
    })
    expect(capability.tools).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith(
      "An MCP tool was withheld because its schema contains credentials",
    )
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("schema-secret")
  })

  it("coalesces tool-list notification bursts without dropping the final directory", async () => {
    const { capability, call } = await setup()
    await call("change_tools", { burst: true })
    await vi.waitFor(() =>
      expect(capability.tools.some((tool) => tool.name.endsWith("__new_tool"))).toBe(true),
    )
    const result = await call("environment")
    const raw = result.structuredContent as { structuredContent: { listRequests: number } }
    expect(raw.structuredContent.listRequests).toBeLessThan(10)
  })

  it("bounds continuous list-change refreshes and closes without automatic reconnect", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-mcp-continuous-"))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const trace = path.join(directory, "requests")
    const { capability, logger } = await setup({
      fake: {
        command: process.execPath,
        args: [fixturePath],
        env: { MCP_TEST_CONTINUOUS: "1", MCP_TEST_LIST_TRACE: trace },
      },
    })
    expect(capability.tools).toEqual([])
    expect((await readFile(trace, "utf8")).trim().split("\n")).toHaveLength(8)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await readFile(trace, "utf8")).trim().split("\n")).toHaveLength(8)
    expect(logger.warn).toHaveBeenCalledWith(
      "MCP continuous tool changes exceeded the refresh limit; connection closed",
    )
  })

  it("awaits initial discovery even after connected initialization and a cancelled startup waiter", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-mcp-opening-"))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const trace = path.join(directory, "requests")
    await setup(
      {
        fake: {
          command: process.execPath,
          args: [fixturePath],
          env: { MCP_TEST_LIST_GATE: path.join(directory, "release"), MCP_TEST_LIST_TRACE: trace },
        },
      },
      {},
      async (capability) => {
        await expect(capability.ready(AbortSignal.timeout(10))).rejects.toThrow()
        await vi.waitFor(async () => expect(await readFile(trace, "utf8")).toContain("list"))
        let complete = false
        const second = capability.ready().then(() => {
          complete = true
        })
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(complete).toBe(false)
        expect(capability.tools).toEqual([])
        await writeFile(path.join(directory, "release"), "ready")
        await second
        expect(capability.tools.length).toBeGreaterThan(0)
      },
    )
  })

  it("gives initial discovery its separate budget after initialization succeeds", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-mcp-init-budget-"))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const trace = path.join(directory, "requests")
    const gate = path.join(directory, "release")
    await setup(
      {
        fake: {
          command: process.execPath,
          args: [fixturePath],
          timeout: 1,
          env: { MCP_TEST_LIST_GATE: gate, MCP_TEST_LIST_TRACE: trace },
        },
      },
      {},
      async (capability) => {
        const opening = capability.ready()
        await vi.waitFor(async () => expect(await readFile(trace, "utf8")).toContain("list"))
        await new Promise((resolve) => setTimeout(resolve, 1100))
        expect(capability.tools).toEqual([])
        await writeFile(gate, "ready")
        await opening
        expect(capability.tools.length).toBeGreaterThan(0)
      },
    )
  })

  it("shares bounded namespace presentation and discards annotations expanded beyond their bound", async () => {
    const { capability } = await setup({
      fake: {
        command: process.execPath,
        args: [fixturePath],
        description: "x".repeat(4096),
        env: {
          SECRET_KEY: "x",
          MCP_TEST_TOOLS: "alpha,beta",
          MCP_TEST_ANNOTATIONS: JSON.stringify({ title: "x".repeat(3500) }),
        },
      },
    })
    expect(capability.tools).toHaveLength(2)
    expect(capability.tools[0]?.namespace).toBe(capability.tools[1]?.namespace)
    expect(capability.tools[0]?.namespace?.description?.length).toBe(4096)
    expect(capability.tools.every((tool) => tool.annotations === undefined)).toBe(true)
    expect(JSON.stringify(capability.tools)).not.toContain("xxx")
  })

  it("reapplies the cumulative publication byte limit after redaction expansion", async () => {
    const { capability, logger } = await setup({
      fake: {
        command: process.execPath,
        args: [fixturePath],
        description: "x".repeat(4096),
        env: {
          SECRET_KEY: "x",
          MCP_TEST_TOOLS: Array.from({ length: 1024 }, (_, i) => `t${i}`).join(","),
          MCP_TEST_SCHEMA: JSON.stringify({ type: "object", description: "x".repeat(2000) }),
        },
      },
    })
    expect(capability.tools.length).toBeGreaterThan(0)
    expect(capability.tools.length).toBeLessThan(1024)
    const bytes = capability.tools.reduce(
      (total, tool) =>
        total +
        Buffer.byteLength(
          JSON.stringify({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            namespace: tool.namespace,
            annotations: tool.annotations,
          }),
        ),
      0,
    )
    expect(bytes).toBeLessThanOrEqual(MCP_MAX_MESSAGE_BYTES)
    expect(logger.warn).toHaveBeenCalledWith(
      "An MCP tool was withheld because redacted metadata exceeds the byte limit",
    )
  })

  it("hashes both sides of a cross-server separator collision", async () => {
    const { capability } = await setup({
      a: { command: process.execPath, args: [fixturePath], env: { MCP_TEST_TOOLS: "b__c" } },
      a__b: { command: process.execPath, args: [fixturePath], env: { MCP_TEST_TOOLS: "c" } },
    })
    const names = capability.tools.map((tool) => tool.name)
    expect(new Set(names).size).toBe(2)
    expect(names).not.toContain("mcp__a__b__c")
    for (const tool of capability.tools)
      expect(
        await tool.execute("collision", {}, undefined, undefined, undefined as never),
      ).toMatchObject({ isError: false })
  })

  it("keeps healthy servers available after another server fails", async () => {
    const { capability, logger } = await setup({
      bad: { command: "/no-such-executable" },
      fake: {
        command: process.execPath,
        args: [fixturePath],
        exposure: "hidden",
        toolExposure: { echo: "direct" },
      },
    })
    expect(capability.tools.map((tool) => tool.name)).toEqual(["mcp__fake__echo"])
    expect(capability.tools[0]?.exposure).toBe("direct")
    expect(logger.warn).toHaveBeenCalled()
  })

  it("does not let partially expanded skipped credentials withhold healthy schemas or alias tool names", async () => {
    const { capability, call } = await setup(
      {
        bad: { command: "node", env: { FIRST: `\${UNUSED}`, LAST: `\${MISSING}` } },
        fake: { command: process.execPath, args: [fixturePath] },
      },
      { UNUSED: "echo" },
    )
    expect(capability.tools.map((tool) => tool.name)).toContain("mcp__fake__echo")
    expect(await call("echo")).toMatchObject({ isError: false })
    const second = await setup(
      {
        bad: { command: "node", env: { FIRST: `\${UNUSED}`, LAST: `\${MISSING}` } },
        fake: { command: process.execPath, args: [fixturePath] },
      },
      { UNUSED: "object" },
    )
    expect(second.capability.tools.map((tool) => tool.name)).toContain("mcp__fake__echo")
    expect(await second.call("echo")).toMatchObject({ isError: false })
  })

  it("does not classify MONKEY or AUTHOR literals as credentials across real healthy servers", async () => {
    const { capability, call } = await setup({
      fake: {
        command: process.execPath,
        args: [fixturePath],
        env: { MONKEY: "object", AUTHOR: "echo" },
      },
      other: { command: process.execPath, args: [fixturePath] },
    })
    expect(capability.tools.map((tool) => tool.name)).toContain("mcp__fake__echo")
    expect(capability.tools.map((tool) => tool.name)).toContain("mcp__other__echo")
    expect(await call("echo")).toMatchObject({ isError: false })
  })

  it("honors absolute deadline even without progress and never retries a side effect", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-mcp-side-effect-"))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const file = path.join(directory, "effects.txt")
    const { call } = await setup({
      fake: { command: process.execPath, args: [fixturePath, file], timeout: 1 },
    })
    await expect(call("hold")).rejects.toThrow("inspect side effects")
    expect(await readFile(file, "utf8")).toBe("called\n")
  })

  it("rechecks caller cancellation after shaping resolves but before delivery", async () => {
    const { call, config } = await setup()
    const abort = new AbortController()
    const original = config.redact
    config.redact = (text) => {
      if (text.includes("abort-after-shape"))
        queueMicrotask(() => abort.abort(new Error("cancelled")))
      return original(text)
    }
    await expect(call("echo", { value: "abort-after-shape" }, abort.signal)).rejects.toThrow(
      "inspect side effects",
    )
    expect(abort.signal.aborted).toBe(true)
  })

  it("cancels calls and refuses new work after closure", async () => {
    const { capability, call } = await setup()
    const abort = new AbortController()
    const held = call("hold", {}, abort.signal)
    abort.abort()
    await expect(held).rejects.toThrow()
    await capability.close()
    expect(capability.tools).toEqual([])
    await expect(capability.ready()).rejects.toThrow("closed")
    await capability.close()
  })

  it("cleans the entire subprocess group and reconnects without resending calls", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-mcp-pids-"))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const pidFile = path.join(directory, "pids.json")
    const { capability, call } = await setup({
      fake: { command: process.execPath, args: [fixturePath, "", pidFile] },
    })
    const pids = JSON.parse(await readFile(pidFile, "utf8")) as { server: number; child: number }
    process.kill(pids.server, "SIGTERM")
    await vi.waitFor(() => expect(capability.tools).toEqual([]))
    // The transport owns and kills the old process group when the server disappears.
    await capability.ready()
    expect(await call("echo")).toMatchObject({ isError: false })
    const next = JSON.parse(await readFile(pidFile, "utf8")) as { server: number; child: number }
    await capability.close()
    for (const pid of [pids.server, pids.child, next.server, next.child])
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 4000 })
  })

  it("can cancel a discovery wait while delayed initialization remains session-owned", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-mcp-delayed-"))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const capability = new McpCapability(
      {
        servers: [
          {
            name: "slow",
            command: process.execPath,
            args: [fixturePath, "", "", "100"],
            env: {},
            headers: {},
            enabled: true,
            timeout: 2,
            timeoutMs: 2000,
            exposure: "codemode",
            toolExposure: {},
          },
        ],
        redact: (s) => s,
      },
      directory,
      path.join(directory, "mcp"),
      { warn: vi.fn() },
      () => {},
    )
    cleanup.push(() => capability.close())
    await expect(capability.ready(AbortSignal.timeout(10))).rejects.toThrow()
    await vi.waitFor(() => expect(capability.tools.length).toBeGreaterThan(0))
  })

  it("cleans a transport whose initialization fails", async () => {
    const transport = new StdioTransport({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    })
    const close = vi.spyOn(transport, "close")
    const capability = new McpCapability(
      {
        servers: [
          {
            name: "slow",
            command: "node",
            args: [],
            env: {},
            headers: {},
            enabled: true,
            timeout: 1,
            timeoutMs: 1000,
            exposure: "codemode",
            toolExposure: {},
          },
        ],
        redact: (s) => s,
      },
      os.tmpdir(),
      path.join(os.tmpdir(), `sumire-mcp-slow-${process.pid}`),
      { warn: vi.fn() },
      () => {},
      () => transport,
    )
    cleanup.push(() =>
      rm(path.join(os.tmpdir(), `sumire-mcp-slow-${process.pid}`), {
        recursive: true,
        force: true,
      }),
    )
    cleanup.push(() => capability.close())
    const started = capability.ready()
    await vi.waitFor(() => expect(transport.pid).toBeDefined())
    await capability.close()
    await started
    expect(close).toHaveBeenCalled()
    expect(capability.tools).toEqual([])
  })

  it.each([
    ["Authorization", "Bearer   remote-secret", "remote-secret", "[redacted]"],
    ["X-Auth", "remote-secret", "remote-secret", "[redacted]"],
    [
      "Authorization",
      "Basic YTpi",
      "a b a:b object banana",
      "[redacted] [redacted] [redacted] object banana",
    ],
    [
      "Authorization",
      `Basic ${Buffer.from("remote-user:remote-secret").toString("base64")}`,
      "remote-user remote-secret remote-user:remote-secret",
      "[redacted] [redacted] [redacted]",
    ],
  ])(
    "handles real Streamable HTTP with %s (%s) without exposing credentials",
    async (header, wireValue, echoed, expected) => {
      const observed: string[] = []
      let expireNextCall = false
      let initializations = 0
      let calls = 0
      const server = createServer(async (req, res) => {
        if (req.method === "GET") {
          res.writeHead(405).end()
          return
        }
        if (req.method === "DELETE") {
          res.writeHead(200).end()
          return
        }
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk)
        const input = JSON.parse(Buffer.concat(chunks).toString())
        observed.push(String(req.headers[header.toLowerCase()] ?? ""))
        if (!input.id) {
          res.writeHead(202).end()
          return
        }
        if (input.method === "initialize") initializations++
        if (input.method === "tools/call") {
          calls++
          if (expireNextCall) {
            expireNextCall = false
            res.writeHead(404).end("remote-secret")
            return
          }
        }
        const result =
          input.method === "initialize"
            ? {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "http", version: "1" },
                instructions: echoed,
              }
            : input.method === "tools/list"
              ? {
                  tools: [{ name: "echo", description: echoed, inputSchema: { type: "object" } }],
                }
              : { content: [{ type: "text", text: echoed }] }
        res
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }))
      })
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      cleanup.push(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections()
            server.close(() => resolve())
          }),
      )
      const address = server.address()
      if (!address || typeof address === "string") throw new Error("Missing test server")
      const { call, logger, capability } = await setup(
        {
          remote: {
            url: `http://127.0.0.1:${address.port}/mcp`,
            timeout: 1.2345,
            headers: {
              [header]: wireValue,
            },
          },
        },
        { KEY: "remote-secret" },
      )
      expect(await call("echo")).toMatchObject({
        content: [
          {
            type: "text",
            text: expected,
          },
        ],
      })
      expect(observed).toContain(wireValue)
      expect(capability.tools[0]).toMatchObject({
        description: expected,
        parameters: { type: "object" },
        namespace: { instructions: expected },
      })
      expect(JSON.stringify(capability.tools)).not.toContain("remote-secret")
      expect(JSON.stringify(capability.tools)).not.toContain("remote-user")
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("remote-secret")
      expireNextCall = true
      await expect(call("echo")).rejects.toThrow("inspect side effects")
      expect(capability.tools).toEqual([])
      await capability.ready()
      expect(initializations).toBe(2)
      expect(calls).toBe(2) // Reconnection never resends the failed invocation.
      expect(await call("echo")).toMatchObject({ isError: false })
    },
  )

  it("uses hash suffixes for every normalized collision and bounds long tool names", () => {
    const tools = ["a-b", "a_b", "a".repeat(100)].map(
      (name) => ({ name, inputSchema: { type: "object" } }) as Tool,
    )
    const names = [...mcpToolNames("chrome-devtools", tools).values()]
    expect(new Set(names).size).toBe(3)
    expect(names.every((name) => name.length <= 64)).toBe(true)
    expect(names[0]).not.toBe("mcp__chrome_devtools__a_b")
    expect(names[1]).not.toBe("mcp__chrome_devtools__a_b")
    const alias = mcpToolNames(
      "s".repeat(100),
      [{ name: "echo", inputSchema: { type: "object" } }],
      () => false,
      (text) => text.replaceAll("echo", "[redacted]"),
    ).get("echo")
    expect(alias?.length).toBeLessThanOrEqual(64)
    expect(alias).not.toContain("echo")
  })

  it("bounds model text and images while retaining raw text for scripts and private full-output files", async () => {
    const { call, directory } = await setup()
    const result = await call("large")
    expect(JSON.stringify(result.content)).toContain("truncated")
    expect(JSON.stringify(result.structuredContent).length).toBeGreaterThan(25000)
    const output = path.join(directory, "mcp", "results")
    const [file] = await readdir(output)
    if (!file) throw new Error("Missing full-output file")
    expect((await stat(output)).mode & 0o777).toBe(0o700)
    expect((await stat(path.join(output, file))).mode & 0o777).toBe(0o600)
    expect((await readFile(path.join(output, file), "utf8")).length).toBe(25000)
    await expect(
      shapeMcpResult(
        { content: [{ type: "text", text: "a".repeat(MCP_MAX_MESSAGE_BYTES) }] },
        directory,
        (s) => s,
      ),
    ).rejects.toThrow("output byte limit")
    await expect(
      shapeMcpResult(
        {
          content: [
            {
              type: "image",
              data: Buffer.alloc(MCP_MAX_IMAGE_BYTES + 1).toString("base64"),
              mimeType: "image/png",
            },
          ],
        },
        directory,
        (s) => s,
      ),
    ).rejects.toThrow("image byte limit")
    expect(
      await shapeMcpResult(
        { content: [], structuredContent: { key: "a\nsecret" } },
        directory,
        (s) => s.replaceAll("a\nsecret", "[redacted]"),
      ),
    ).toMatchObject({ structuredContent: { structuredContent: { key: "[redacted]" } } })
  })
})
