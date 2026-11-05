import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect, it, vi } from "vitest"
import { McpCapability } from "../src/agent/mcp-capability.js"
import { parseMcpConfig } from "../src/agent/mcp-config.js"

it("classifies a configured HTTP listing deadline as timeout without retries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-mcp-http-observation-"))
  const methods: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init: RequestInit) => {
      if (init.method !== "POST") return new Response(null, { status: 405 })
      const message = JSON.parse(String(init.body))
      methods.push(message.method)
      if (message.method === "tools/list") {
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init.signal
          if (!signal) throw new Error("Missing bounded HTTP signal")
          const abort = () => reject(signal.reason)
          if (signal.aborted) abort()
          else signal.addEventListener("abort", abort, { once: true })
        })
      }
      if (!message.id) return new Response(null, { status: 202 })
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        },
      })
    }),
  )
  const config = parseMcpConfig(
    { mcpServers: { fixture: { url: "https://example.com/mcp", timeout: 1 } } },
    { warn: () => {} },
    {},
  )
  const capability = new McpCapability(
    config,
    directory,
    path.join(directory, "mcp"),
    { warn: () => {} },
    () => {},
  )
  try {
    await capability.ready()
    expect(capability.discoveryOutcome("fixture")).toEqual({ state: "failed", reason: "timeout" })
    expect(capability.tools).toEqual([])
    expect(methods.filter((method) => method === "initialize")).toHaveLength(1)
    expect(methods.filter((method) => method === "tools/list")).toHaveLength(1)
  } finally {
    await capability.close()
    vi.unstubAllGlobals()
    await rm(directory, { recursive: true, force: true })
  }
})
