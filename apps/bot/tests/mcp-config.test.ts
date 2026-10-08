import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { loadMcpConfig, toolExposure } from "../src/agent/mcp-config.js"
import { loadSettings } from "../src/config/settings.js"

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
async function config(input: unknown, environment: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-mcp-config-"))
  directories.push(directory)
  const file = path.join(directory, "mcp.json")
  await writeFile(file, typeof input === "string" ? input : JSON.stringify(input))
  const logger = { warn: vi.fn() }
  return {
    ...(await loadMcpConfig({ botMcpEnabled: true, botMcpConfigPath: file }, logger, environment)),
    logger,
  }
}

describe("MCP configuration", () => {
  it("defaults off and resolves config against the application root, not workdir", async () => {
    const settings = loadSettings({ BOT_WORKDIR: "/workdir" }, "/app")
    expect(settings.botMcpEnabled).toBe(false)
    expect(settings.botMcpConfigPath).toBe("/app/mcp.json")
    expect(loadSettings({ BOT_MCP_CONFIG_PATH: "private/mcp.json" }, "/app").botMcpConfigPath).toBe(
      "/app/private/mcp.json",
    )
    expect(
      await loadMcpConfig({ ...settings, botMcpConfigPath: "/missing" }, { warn: vi.fn() }),
    ).toMatchObject({ servers: [] })
  })

  it("loads the requested tracked Chrome and Firecrawl config without changing its args", async () => {
    const result = await loadMcpConfig(
      {
        botMcpEnabled: true,
        botMcpConfigPath: new URL("../../../mcp.json", import.meta.url).pathname,
      },
      { warn: vi.fn() },
      { FIRECRAWL_API_KEY: "fixture-secret" },
    )
    expect(result.servers.map((server) => server.name)).toEqual(["chrome-devtools", "firecrawl"])
    expect(result.servers[0]?.args).toEqual(["-y", "chrome-devtools-mcp@latest"])
    expect(result.servers[1]?.headers.Authorization).toBe("Bearer fixture-secret")
  })

  it("fails safely for a missing file, invalid JSON or invalid top-level shape", async () => {
    await expect(
      loadMcpConfig({ botMcpEnabled: true, botMcpConfigPath: "/missing" }, { warn: vi.fn() }),
    ).rejects.toThrow("bounded JSON")
    await expect(config("secret invalid JSON")).rejects.toThrow("bounded JSON")
    await expect(config({ mcpServers: [] })).rejects.toThrow("mcpServers object")
  })

  it("expands credentials, redacts raw token and skips entries with missing credentials", async () => {
    const result = await config(
      {
        mcpServers: {
          remote: { url: "https://example.com/mcp", headers: { Authorization: `Bearer \${KEY}` } },
          missing: {
            url: "https://example.com/mcp",
            headers: { Authorization: `Bearer \${MISSING}` },
          },
          local: { command: "node", env: { TOKEN: `\${KEY}` } },
        },
      },
      { KEY: "test-secret" },
    )
    expect(result.servers.map((s) => s.name)).toEqual(["remote", "local"])
    expect(result.servers[0]?.headers.Authorization).toBe("Bearer test-secret")
    expect(result.redact("Bearer test-secret test-secret")).toBe("[redacted] [redacted]")
    expect(JSON.stringify(result.logger.warn.mock.calls)).not.toContain("test-secret")
  })

  it("redacts literal authorization payloads and individual cookie values", async () => {
    const result = await config({
      mcpServers: {
        remote: {
          url: "https://example.com/mcp",
          headers: {
            Authorization: "Basic encoded-secret",
            Cookie: "first=cookie-secret; second=other-secret",
          },
        },
      },
    })
    expect(result.redact("encoded-secret cookie-secret other-secret")).toBe(
      "[redacted] [redacted] [redacted]",
    )
  })

  it.each(["X-Auth", "x-auth", "Authentication", "XAuth"])(
    "redacts literal credentials from %s",
    async (header) => {
      const result = await config({
        mcpServers: {
          remote: { url: "https://example.com/mcp", headers: { [header]: "custom-auth-secret" } },
        },
      })
      expect(result.redact("custom-auth-secret")).toBe("[redacted]")
      expect(result.servers[0]?.headers[header]).toBe("custom-auth-secret")
    },
  )

  it.each([
    { command: "node", url: "https://example.com/mcp" },
    { command: "node", type: "http" },
    { url: "https://user:pass@example.com/mcp" },
    { url: "file:///tmp/mcp" },
    { command: "node", exposure: "deferred" },
    { command: "node", headers: { Authorization: "value" } },
    { command: "node", env: { KEY: "!echo secret" } },
    { command: "node", env: { KEY: "  !echo secret" } },
    { command: "node", env: { KEY: `\${invalid-name}` } },
    { command: "node", env: { KEY: `\${constructor}` } },
    { command: "node", timeout: 0 },
    { url: "https://example.com/mcp", oauth: {} },
  ])("skips unsupported or unsafe server settings without exposing values: %j", async (entry) => {
    const result = await config({ mcpServers: { bad: entry, good: { command: "node" } } })
    expect(result.servers.map((s) => s.name)).toEqual(["good"])
    expect(result.logger.warn).toHaveBeenCalledTimes(1)
  })

  it("rejects both colliding server names and skips disabled entries without expanding secrets", async () => {
    const result = await config({
      mcpServers: {
        "a-b": { command: "node" },
        a_b: { command: "node" },
        "bad name": { command: "node" },
        disabled: { command: "node", enabled: false, env: { TOKEN: `\${UNSET}` } },
      },
    })
    expect(result.servers).toEqual([])
    expect(result.logger.warn).toHaveBeenCalledTimes(3)
  })

  it.each([
    { entry: { command: "node", enabled: false, env: { TOKEN: "${UNSET}" } }, warnings: 0 },
    { entry: { command: "node", timeout: 0 }, warnings: 1 },
    { entry: { command: "node", env: { TOKEN: "${UNSET}" } }, warnings: 1 },
  ])(
    "does not let skipped colliding entries suppress valid servers: %j",
    async ({ entry, warnings }) => {
      for (const reverse of [false, true]) {
        const entries = [
          ["a-b", { command: "node" }],
          ["a_b", entry],
        ] as const
        const result = await config({
          mcpServers: Object.fromEntries(reverse ? [...entries].reverse() : entries),
        })
        expect(result.servers.map((server) => server.name)).toEqual(["a-b"])
        expect(result.logger.warn).toHaveBeenCalledTimes(warnings)
        expect(JSON.stringify(result.logger.warn.mock.calls)).not.toContain("UNSET")
      }
    },
  )

  it("applies exact tool exposure before wildcard patterns", async () => {
    const result = await config({
      mcpServers: {
        local: {
          command: "node",
          exposure: "hidden",
          toolExposure: { "get_*": "codemode", get_secret: "hidden", status: "direct" },
        },
      },
    })
    const server = result.servers[0]
    if (!server) throw new Error("Missing server")
    expect(toolExposure(server, "get_items")).toBe("codemode")
    expect(toolExposure(server, "get_secret")).toBe("hidden")
    expect(toolExposure(server, "status")).toBe("direct")
    expect(toolExposure(server, "delete")).toBe("hidden")
    for (const name of ["constructor", "toString", "__proto__"])
      expect(toolExposure(server, name)).toBe("hidden")
  })
})
