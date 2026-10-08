import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  loadMcpConfig,
  MCP_MAX_SERVER_NAME_LENGTH,
  MCP_MAX_SERVERS,
  toolExposure,
} from "../src/agent/mcp-config.js"
import { MCP_MAX_CONFIG_BYTES } from "../src/agent/mcp-config-file.js"
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
    ...(await loadMcpConfig({ botMcpConfigPath: file }, logger, environment)),
    logger,
  }
}

describe("MCP configuration", () => {
  it("resolves config against the application root, not workdir", () => {
    const settings = loadSettings({}, "/app", "/workdir")
    expect(settings.botWorkdir).toBe("/workdir")
    expect(settings.botMcpConfigPath).toBe("/app/mcp.json")
  })

  it("loads MCP configuration without an enable flag", async () => {
    const result = await config({ mcpServers: { local: { command: "node" } } })
    expect(result.servers.map((server) => server.name)).toEqual(["local"])
  })

  it("accepts an empty configuration to disable all MCP servers", async () => {
    expect((await config({ mcpServers: {} })).servers).toEqual([])
  })

  it("loads the requested tracked Chrome and Firecrawl config without changing its args", async () => {
    const result = await loadMcpConfig(
      {
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
      loadMcpConfig({ botMcpConfigPath: "/missing" }, { warn: vi.fn() }),
    ).rejects.toThrow("bounded JSON")
    await expect(config("secret invalid JSON")).rejects.toThrow("bounded JSON")
    await expect(config({ mcpServers: [] })).rejects.toThrow("mcpServers object")
  })

  it("accepts the exact config byte limit and safely rejects one byte more", async () => {
    const input = '{"mcpServers":{}}'
    expect((await config(input.padEnd(MCP_MAX_CONFIG_BYTES, " "))).servers).toEqual([])
    await expect(config(input.padEnd(MCP_MAX_CONFIG_BYTES + 1, " "))).rejects.toThrow(
      "bounded JSON",
    )
  })

  it.each(["environment", "headers", "collision", "disabled"])(
    "does not commit secrets from skipped %s entries",
    async (mode) => {
      const bad =
        mode === "headers"
          ? {
              url: "https://example.com/mcp",
              headers: { First: `\${UNUSED}`, Last: `\${MISSING}` },
            }
          : {
              command: "node",
              enabled: mode !== "disabled",
              env: {
                First: `\${UNUSED}`,
                ...(mode === "environment" ? { Last: `\${MISSING}` } : {}),
              },
            }
      const entries: Record<string, unknown> = {
        b_ad: bad,
        healthy: { command: "node", env: { TOKEN: `\${ACTIVE}` } },
      }
      if (mode === "collision") entries["b-ad"] = { command: "node" }
      const result = await config(
        { mcpServers: entries },
        { UNUSED: "object", ACTIVE: "active-secret" },
      )
      expect(result.servers.map((server) => server.name)).toEqual(["healthy"])
      expect(result.redact("object active-secret")).toBe("object [redacted]")
      expect(JSON.stringify(result.logger.warn.mock.calls)).not.toContain("object")
    },
  )

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

  it.each([
    ["Authorization", "Basic", "user:pass"],
    ["Proxy-Authorization", "bAsIc", "operator:pass:with:colons"],
    ["X-Auth", "BASIC", "名前:秘密"],
    ["Authorization", "Basic", ":password-only"],
    ["Authorization", "Basic", "username-only:"],
  ])("redacts decoded Basic credentials from %s", async (header, scheme, decoded) => {
    const payload = Buffer.from(decoded).toString("base64")
    const value = `  ${scheme}\t  ${payload}  `
    const result = await config({
      mcpServers: { remote: { url: "https://example.com/mcp", headers: { [header]: value } } },
    })
    expect(result.servers[0]?.headers[header]).toBe(value)
    for (const secret of [
      value,
      payload,
      decoded,
      decoded.slice(0, decoded.indexOf(":")),
      decoded.slice(decoded.indexOf(":") + 1),
    ])
      if (secret) expect(result.redact(secret)).toBe("[redacted]")
    expect(result.logger.warn).not.toHaveBeenCalled()
  })

  it("redacts short Basic components only at boundaries and retains explicit-secret precedence", async () => {
    const remote = { url: "https://example.com/mcp", headers: { Authorization: "Basic YTpi" } }
    const result = await config({ mcpServers: { remote } })
    expect(result.redact("a b a:b object banana")).toBe(
      "[redacted] [redacted] [redacted] object banana",
    )
    const explicit = await config({
      mcpServers: { remote, local: { command: "node", env: { TOKEN: "b" } } },
    })
    expect(explicit.redact("object")).toBe("o[redacted]ject")
  })

  it.each(["not-base64", "dXNlcg==", "/zpzZWNyZXQ=", "dXNlcjpwYXNz!"])(
    "does not derive secrets from malformed Basic payload %s",
    async (payload) => {
      const result = await config({
        mcpServers: {
          remote: {
            url: "https://example.com/mcp",
            headers: { Authorization: `Basic ${payload}` },
          },
        },
      })
      expect(result.servers).toHaveLength(1)
      expect(result.redact("user secret pass")).toBe("user secret pass")
      expect(result.redact(payload)).toBe("[redacted]")
    },
  )

  it("bounds derived Basic secrets and isolates skipped entries", async () => {
    const headers = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `X-Auth-${i}`,
        `Basic ${Buffer.from(`user-${i}:password-${i}`).toString("base64")}`,
      ]),
    )
    const result = await config({
      mcpServers: {
        excessive: { url: "https://example.com/mcp", headers },
        healthy: { command: "node", env: { TOKEN: "healthy-secret" } },
      },
    })
    expect(result.servers.map((server) => server.name)).toEqual(["healthy"])
    expect(result.redact("user-0 password-0 healthy-secret")).toBe("user-0 password-0 [redacted]")
    expect(result.logger.warn).toHaveBeenCalledExactlyOnceWith(
      "An MCP server was skipped: invalid configuration or missing environment",
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
    { entry: { command: "node", enabled: false, env: { TOKEN: `\${UNSET}` } }, warnings: 0 },
    { entry: { command: "node", timeout: 0 }, warnings: 1 },
    { entry: { command: "node", env: { TOKEN: `\${UNSET}` } }, warnings: 1 },
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

  it.each([
    [1.2345, 1235],
    [1.001, 1001],
    [0.0001, 1],
    [60, 60_000],
    [3600, 3_600_000],
  ])(
    "normalizes %s seconds once to %s positive integer milliseconds",
    async (timeout, timeoutMs) => {
      const result = await config({ mcpServers: { fake: { command: "node", timeout } } })
      expect(result.servers[0]).toMatchObject({ timeout, timeoutMs })
      expect(() => AbortSignal.timeout(result.servers[0]?.timeoutMs as number)).not.toThrow()
    },
  )

  it("keeps ordinary literal values out of redaction but honors explicit environment interpolation", async () => {
    const result = await config(
      {
        mcpServers: {
          local: { command: "node", env: { MONKEY: "object", AUTHOR: "echo" } },
          remote: {
            url: "https://example.com/mcp?author=writer&project=public",
            headers: { AUTHOR: "writer", "X-Auth": "active-secret" },
          },
          explicit: { command: "node", env: { ORDINARY: `\${EXPLICIT}` } },
        },
      },
      { EXPLICIT: "explicit-secret" },
    )
    expect(result.servers).toHaveLength(3)
    expect(result.redact("object echo writer active-secret explicit-secret")).toBe(
      "object echo writer [redacted] [redacted]",
    )
  })

  it.each(["api_key", "apiKey", "APIKEY", "access_token", "password", "signature", "%61pi_key"])(
    "rejects query credential %s without exposing its URL or value",
    async (key) => {
      const result = await config({
        mcpServers: {
          bad: { url: `https://example.com/mcp?${key}=query-secret` },
          good: { command: "node" },
        },
      })
      expect(result.servers.map((server) => server.name)).toEqual(["good"])
      expect(result.logger.warn).toHaveBeenCalledOnce()
      expect(JSON.stringify(result.logger.warn.mock.calls)).not.toContain("query-secret")
    },
  )

  it("bounds server names before credential expansion and leaves healthy entries available", async () => {
    const max = "a".repeat(MCP_MAX_SERVER_NAME_LENGTH)
    const result = await config({
      mcpServers: {
        [max]: { command: "node" },
        [`${max}a`]: { command: "node", env: { TOKEN: `\${MISSING}` } },
        ["b".repeat(500_000)]: { command: "node" },
      },
    })
    expect(result.servers.map((server) => server.name)).toEqual([max])
    expect(result.logger.warn).toHaveBeenCalledTimes(2)
  })

  it("accepts the server-count boundary and fails before expanding over-limit entries", async () => {
    const entries = Object.fromEntries(
      Array.from({ length: MCP_MAX_SERVERS }, (_, i) => [`server_${i}`, { command: "node" }]),
    )
    expect((await config({ mcpServers: entries })).servers).toHaveLength(MCP_MAX_SERVERS)
    const environment = {
      get MUST_NOT_READ(): string {
        throw new Error("Expansion must not occur")
      },
    }
    await expect(
      config(
        {
          mcpServers: {
            ...entries,
            extra: { command: "node", env: { TOKEN: `\${MUST_NOT_READ}` } },
          },
        },
        environment,
      ),
    ).rejects.toThrow("at most 16 server entries")
  })

  it.each(["Authorization", "X-Auth", "XAuth", "Authentication"])(
    "trims scheme payloads for %s without modifying wire credentials",
    async (header) => {
      const value = "  Bearer\t   payload-secret  "
      const result = await config({
        mcpServers: { remote: { url: "https://example.com/mcp", headers: { [header]: value } } },
      })
      expect(result.servers[0]?.headers[header]).toBe(value)
      expect(result.redact("payload-secret")).toBe("[redacted]")
    },
  )

  it("bounds exposure maps and pattern lengths while preserving healthy servers", async () => {
    const patterns = Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [`tool_${i}*`, "hidden"]),
    )
    const result = await config({
      mcpServers: {
        good: { command: "node", toolExposure: { ...patterns, ["a".repeat(128)]: "direct" } },
        boundary: { command: "node", toolExposure: patterns },
        tooLong: { command: "node", toolExposure: { ["a".repeat(129)]: "hidden" } },
        lengthBoundary: { command: "node", toolExposure: { ["a".repeat(128)]: "direct" } },
      },
    })
    expect(result.servers.map((server) => server.name)).toEqual(["boundary", "lengthBoundary"])
  })

  it.each([
    ["a*b*c", "abbbc", true],
    ["a*b*c", "ac", false],
    ["*a*a", "a", false],
    ["*a*a", "aa", true],
    ["**", "anything", true],
    ["a*", "ba", false],
    ["*c", "cd", false],
    ["a.+*", "a.+tail", true],
    ["a.+*", "abc", false],
    ["a*b", "a\nb", true],
  ] as const)("matches literal wildcard %s against %s", async (pattern, name, matches) => {
    const result = await config({
      mcpServers: { local: { command: "node", toolExposure: { [pattern]: "hidden" } } },
    })
    const server = result.servers[0]
    if (!server) throw new Error("Missing server")
    expect(toolExposure(server, name)).toBe(matches ? "hidden" : "codemode")
    expect(toolExposure(server, name)).toBe(matches ? "hidden" : "codemode")
  })

  it("bounds env/header field counts and derived credentials without suppressing healthy entries", async () => {
    const fields = Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [`FIELD_${i}`, "ordinary"]),
    )
    const result = await config({
      mcpServers: {
        boundary: { command: "node", env: fields },
        excess: { command: "node", env: { ...fields, EXTRA: "ordinary" } },
        oversized: { command: "node", env: { TOKEN: "private".repeat(1000) } },
        cookies: {
          url: "https://example.com/mcp",
          headers: { Cookie: Array.from({ length: 128 }, (_, i) => `key${i}=value${i}`).join(";") },
        },
      },
    })
    expect(result.servers.map((server) => server.name)).toEqual(["boundary"])
    expect(JSON.stringify(result.logger.warn.mock.calls)).not.toContain("private")
  })

  it("bounds the global accepted credential set before creating its redactor", async () => {
    const entries = Object.fromEntries(
      Array.from({ length: 2 }, (_, server) => [
        `s${server}`,
        {
          command: "node",
          env: Object.fromEntries(
            Array.from({ length: 64 }, (_, i) => [`TOKEN_${i}`, `credential-${server}-${i}`]),
          ),
        },
      ]),
    )
    expect((await config({ mcpServers: entries })).servers).toHaveLength(2)
    await expect(
      config({
        mcpServers: { ...entries, extra: { command: "node", env: { TOKEN: "extra-credential" } } },
      }),
    ).rejects.toThrow("credential count")
  })

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
