import { StreamableHttpTransport } from "@earendil-works/pi-mcp"
import { describe, expect, it, vi } from "vitest"
import { boundedMcpFetch } from "../src/agent/mcp-http.js"
import { MCP_MAX_MESSAGE_BYTES } from "../src/agent/mcp-results.js"

describe("MCP HTTP bounds", () => {
  it("enforces streamed JSON and error limits without trusting content-length", async () => {
    let cancelled = false
    const request = boundedMcpFetch(
      1000,
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new Uint8Array(1_000_000))
            },
            cancel() {
              cancelled = true
            },
          }),
          { headers: { "content-type": "application/json", "content-length": "1" } },
        ),
    )
    const response = await request("https://example.com/mcp")
    await expect(response.json()).rejects.toThrow("byte limit")
    await Promise.resolve()
    expect(cancelled).toBe(true)
  })

  it.each([
    "text/event-stream",
    "Text/Event-Stream; charset=utf-8",
    " TEXT/EVENT-STREAM ; charset=UTF-8",
  ])(
    "passes %s to Pi's event-bounded reader and keeps redirect and deadline controls",
    async (contentType) => {
      const request = boundedMcpFetch(1000, async (_url, init) => {
        expect(init?.redirect).toBe("error")
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        return new Response("data: {}\n\n", { headers: { "content-type": contentType } })
      })
      expect(await (await request("https://example.com/mcp")).text()).toBe("data: {}\n\n")
      expect(MCP_MAX_MESSAGE_BYTES).toBe(8_000_000)
    },
  )

  it.each([false, true])(
    "leaves mixed-case SSE under Pi's per-event bound (oversized: %s)",
    async (oversized) => {
      const event = new TextEncoder().encode(
        `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { payload: "x".repeat(oversized ? MCP_MAX_MESSAGE_BYTES + 1 : 1_000_000) } })}\n\n`,
      )
      const final = new TextEncoder().encode('data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n')
      let sent = 0
      const transport = new StreamableHttpTransport({
        url: "https://example.com/mcp",
        maxMessageBytes: MCP_MAX_MESSAGE_BYTES,
        fetch: boundedMcpFetch(
          1000,
          async () =>
            new Response(
              new ReadableStream({
                pull(controller) {
                  if (sent < (oversized ? 1 : 9)) controller.enqueue(event)
                  else if (!oversized && sent === 9) controller.enqueue(final)
                  else controller.close()
                  sent++
                },
              }),
              { headers: { "content-type": "Text/Event-Stream; charset=utf-8" } },
            ),
        ),
      })
      const message = vi.fn()
      const error = vi.fn()
      transport.onMessage(message)
      transport.onError(error)
      await transport.start()
      try {
        await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
        await vi.waitFor(() => {
          expect(message).toHaveBeenCalledTimes(oversized ? 1 : 10)
        })
        if (oversized)
          expect(message.mock.calls[0]?.[0]).toMatchObject({
            id: 1,
            error: { message: expect.stringContaining("MCP SSE event exceeds") },
          })
        else expect(error).not.toHaveBeenCalled()
      } finally {
        await transport.close()
      }
    },
  )

  it("does not exempt misleading non-SSE media types from the body bound", async () => {
    const request = boundedMcpFetch(
      1000,
      async () =>
        new Response(new Uint8Array(MCP_MAX_MESSAGE_BYTES + 1), {
          headers: { "content-type": "application/text/event-stream" },
        }),
    )
    await expect((await request("https://example.com/mcp")).arrayBuffer()).rejects.toThrow(
      "byte limit",
    )
  })
})
