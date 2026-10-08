import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, it, vi } from "vitest"
import { loadMcpConfig } from "../src/agent/mcp-config.js"

const { selectSmokeConfig } = await import(
  new URL("../scripts/mcp-smoke-config.mjs", import.meta.url).href
)
const chrome = Object.freeze({
  command: "node",
  args: Object.freeze(["/app/apps/bot/scripts/chrome-devtools.mjs"]),
  env: Object.freeze({ PLAYWRIGHT_BROWSERS_PATH: "/ms-playwright" }),
  timeout: 7,
  toolExposure: Object.freeze({ take_snapshot: "direct" }),
})
const firecrawl = Object.freeze({
  url: "https://mcp.firecrawl.dev/v2/mcp",
  headers: Object.freeze({ Authorization: `Bearer \${FIRECRAWL_API_KEY}` }),
})
const extra = Object.freeze({ command: "unused", env: { KEY: `\${UNAVAILABLE_CUSTOM_KEY}` } })

it.each([
  {
    flags: { chromeOnly: true },
    servers: { "chrome-devtools": chrome, extra },
    names: ["chrome-devtools"],
  },
  { flags: { firecrawlOnly: true }, servers: { firecrawl, extra }, names: ["firecrawl"] },
  { flags: {}, servers: { "chrome-devtools": chrome, extra }, names: ["chrome-devtools"] },
  { flags: {}, servers: { firecrawl, extra }, names: ["firecrawl"] },
  {
    flags: {},
    servers: { "chrome-devtools": chrome, firecrawl, extra },
    names: ["chrome-devtools", "firecrawl"],
  },
  {
    flags: {},
    servers: { "chrome-devtools": chrome, firecrawl: { ...firecrawl, enabled: false }, extra },
    names: ["chrome-devtools"],
  },
])(
  "selects only enabled requested defaults without mutating customized input: $names",
  ({ flags, servers, names }) => {
    const input = Object.freeze({ mcpServers: Object.freeze(servers) })
    const before = JSON.stringify(input)
    const selected = selectSmokeConfig(input, flags)
    expect(Object.keys(selected.mcpServers)).toEqual(names)
    expect(JSON.stringify(input)).toBe(before)
    expect(selected.mcpServers).not.toBe(input.mcpServers)
    for (const name of names) expect(selected.mcpServers[name]).toBe(Reflect.get(servers, name))
  },
)

it.each([
  { flags: { chromeOnly: true }, servers: { firecrawl }, target: "chrome-devtools" },
  { flags: { firecrawlOnly: true }, servers: { "chrome-devtools": chrome }, target: "firecrawl" },
  {
    flags: { chromeOnly: true },
    servers: { "chrome-devtools": { ...chrome, enabled: false } },
    target: "chrome-devtools",
  },
  {
    flags: { firecrawlOnly: true },
    servers: { firecrawl: { ...firecrawl, enabled: false } },
    target: "firecrawl",
  },
])(
  "fails clearly when the explicitly requested $target is absent or disabled",
  ({ flags, servers, target }) => {
    expect(() => selectSmokeConfig({ mcpServers: servers }, flags)).toThrow(
      `Requested smoke server ${target} is missing or disabled`,
    )
  },
)

it.each([{ mcpServers: {} }, { mcpServers: { extra } }])(
  "does not silently pass with no smoke targets",
  (input) => {
    expect(() => selectSmokeConfig(input)).toThrow("No enabled default MCP servers")
  },
)

it.each([null, [], {}, { mcpServers: [] }])("rejects invalid server-map shapes", (input) => {
  expect(() => selectSmokeConfig(input)).toThrow(
    "MCP smoke configuration must contain a server map",
  )
})

it("rejects mutually exclusive filters", () => {
  expect(() =>
    selectSmokeConfig(
      { mcpServers: { "chrome-devtools": chrome, firecrawl } },
      {
        chromeOnly: true,
        firecrawlOnly: true,
      },
    ),
  ).toThrow("Choose only one server filter")
})

it("preserves top-level fields for the existing strict config validation", () => {
  expect(
    selectSmokeConfig({ mcpServers: { "chrome-devtools": chrome }, unexpected: true }),
  ).toHaveProperty("unexpected", true)
})

it.each([
  { server: "chrome-devtools", entry: chrome, flags: { chromeOnly: true } },
  {
    server: "firecrawl",
    entry: { ...firecrawl, headers: { Authorization: "Bearer test-only-key" } },
    flags: { firecrawlOnly: true },
  },
])(
  "validates customized $server without unrelated environment credentials",
  async ({ server, entry, flags }) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-smoke-config-test-"))
    try {
      const file = path.join(directory, "mcp.json")
      const selected = selectSmokeConfig({ mcpServers: { [server]: entry, extra } }, flags)
      await writeFile(file, JSON.stringify(selected), { mode: 0o600 })
      const warn = vi.fn()
      const config = await loadMcpConfig({ botMcpConfigPath: file }, { warn }, {})
      expect(config.servers).toHaveLength(Object.keys(selected.mcpServers).length)
      expect(config.servers[0]).toMatchObject({ ...entry, name: server })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)
