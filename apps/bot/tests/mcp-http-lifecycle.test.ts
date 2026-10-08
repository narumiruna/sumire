import { createServer, type RequestListener } from "node:http"
import { StreamableHttpTransport } from "@earendil-works/pi-mcp"
import { afterEach, describe, expect, it, vi } from "vitest"
import { boundedMcpFetch } from "../src/agent/mcp-http.js"
import { MCP_MAX_MESSAGE_BYTES } from "../src/agent/mcp-results.js"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function endpoint(handler: RequestListener) {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Missing server address")
  return `http://127.0.0.1:${address.port}/mcp`
}

describe("MCP HTTP deadline lifecycle with Node fetch", () => {
  it("delivers standalone notifications after the request deadline without reopening, and closes the stream on transport shutdown", async () => {
    let gets = 0
    let closed = 0
    const url = await endpoint((req, res) => {
      if (req.method !== "GET") {
        res.writeHead(202).end()
        return
      }
      gets++
      res.writeHead(200, { "Content-Type": "Text/Event-Stream" })
      res.flushHeaders()
      const timer = setTimeout(
        () => res.write('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n'),
        600,
      )
      res.on("close", () => {
        clearTimeout(timer)
        closed++
      })
    })
    const transport = new StreamableHttpTransport({
      url,
      fetch: boundedMcpFetch(200),
      maxMessageBytes: MCP_MAX_MESSAGE_BYTES,
    })
    cleanups.push(() => transport.close())
    const message = vi.fn()
    const error = vi.fn()
    transport.onMessage(message)
    transport.onError(error)
    await transport.start()
    await transport.send({ jsonrpc: "2.0", method: "notifications/initialized" })
    await vi.waitFor(
      () =>
        expect(message).toHaveBeenCalledWith({
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
        }),
      { timeout: 3000 },
    )
    expect(gets).toBe(1)
    expect(error).not.toHaveBeenCalled()
    await transport.close()
    await vi.waitFor(() => expect(closed).toBe(1))
  })

  it("keeps a stalled GET header wait bounded", async () => {
    const url = await endpoint(() => {})
    await expect(boundedMcpFetch(200)(url, { method: "GET" })).rejects.toMatchObject({
      name: "TimeoutError",
    })
  })

  it.each([
    { method: "POST", status: 200 },
    { method: "GET", status: 500 },
  ])(
    "retains body deadlines for $method status $status even with an SSE media type",
    async ({ method, status }) => {
      const url = await endpoint((_req, res) => {
        res.writeHead(status, { "Content-Type": "text/event-stream" })
        res.flushHeaders()
      })
      const response = await boundedMcpFetch(200)(url, { method })
      await expect(response.text()).rejects.toThrow()
    },
  )

  it("preserves caller cancellation on a successful GET after its header deadline is released", async () => {
    const url = await endpoint((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" })
      res.flushHeaders()
    })
    const caller = new AbortController()
    const response = await boundedMcpFetch(200)(url, { method: "GET", signal: caller.signal })
    const body = response.text()
    caller.abort()
    await expect(body).rejects.toThrow()
  })
})
