import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { McpCapability } from "../src/agent/mcp-capability.js"
import { parseMcpConfig } from "../src/agent/mcp-config.js"

const fixture = new URL("./fixtures/mcp-observation-server.mjs", import.meta.url).pathname

describe("typed MCP discovery outcomes", () => {
  it.each([
    ["empty", "codemode", "succeeded", undefined, 0],
    ["nonempty", "codemode", "succeeded", undefined, 1],
    ["nonempty", "hidden", "succeeded", undefined, 0],
    ["transport", "codemode", "failed", "transport", 0],
    ["listing-error", "codemode", "failed", "listing", 0],
    ["malformed", "codemode", "failed", "listing", 0],
    ["timeout", "codemode", "failed", "timeout", 0],
  ] as const)(
    "reports %s (%s) without reading logs or publication length",
    async (mode, exposure, state, reason, count) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-mcp-outcome-"))
      const trace = path.join(directory, "trace")
      const logger = { warn: vi.fn() }
      const config = parseMcpConfig(
        {
          mcpServers: {
            fixture: {
              command: mode === "transport" ? "/no-such-sumire-mcp-executable" : process.execPath,
              args: [fixture, mode, trace],
              exposure,
              timeout: mode === "timeout" ? 1 : 2,
            },
          },
        },
        logger,
        {},
      )
      const capability = new McpCapability(
        config,
        directory,
        path.join(directory, "mcp"),
        logger,
        () => {},
      )
      try {
        expect(capability.discoveryOutcome("fixture")).toEqual({ state: "untested" })
        expect(capability.discoveryOutcome("missing")).toBeUndefined()
        const started = capability.ready()
        expect(capability.discoveryOutcome("fixture")).toEqual({ state: "checking" })
        await expect(started).resolves.toBeUndefined()
        expect(capability.discoveryOutcome("fixture")).toEqual(
          reason ? { state, reason } : { state },
        )
        expect(capability.tools).toHaveLength(count)
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private-secret")
        if (mode !== "transport") {
          const methods = (await readFile(trace, "utf8")).trim().split("\n")
          expect(methods.filter((method) => method === "initialize")).toHaveLength(1)
          expect(methods.filter((method) => method === "tools/list")).toHaveLength(
            mode === "timeout" ? 0 : 1,
          )
        }
      } finally {
        await capability.close()
        expect(await readdir(path.join(directory, "mcp"))).toEqual([])
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
})
