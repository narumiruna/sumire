import { getEventListeners } from "node:events"
import { StreamableHttpTransport } from "@earendil-works/pi-mcp"
import { afterEach, describe, expect, it, vi } from "vitest"
import { boundedMcpFetch } from "../src/agent/mcp-http.js"
import { MCP_MAX_MESSAGE_BYTES } from "../src/agent/mcp-results.js"

afterEach(() => vi.useRealTimers())

describe("MCP HTTP bounds", () => {
  it.each([
    "bodyless",
    "json",
    "http-error",
    "post-sse",
    "read-error",
    "cancel",
    "overflow",
    "fetch-error",
  ])("releases deadline state after %s", async (mode) => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const cancel = vi.fn()
    const source =
      mode === "read-error"
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(new Error("read failed"))
            },
          })
        : mode === "cancel"
          ? new ReadableStream<Uint8Array>({ cancel })
          : undefined
    const request = boundedMcpFetch(3_600_000, async (_url, init) => {
      signal = init?.signal ?? undefined
      if (mode === "fetch-error") throw new Error("fetch failed")
      if (mode === "bodyless") return new Response(null, { status: 204 })
      return new Response(
        source ?? (mode === "overflow" ? new Uint8Array(MCP_MAX_MESSAGE_BYTES + 1) : "{}"),
        {
          status: mode === "http-error" ? 500 : 200,
          headers: {
            "content-type": mode === "post-sse" ? "text/event-stream" : "application/json",
          },
        },
      )
    })
    if (mode === "fetch-error")
      await expect(request("https://example.com/mcp", { method: "POST" })).rejects.toThrow(
        "fetch failed",
      )
    else {
      const response = await request("https://example.com/mcp", { method: "POST" })
      if (mode === "cancel") {
        await response.body?.cancel("cancel reason")
        expect(cancel).toHaveBeenCalledWith("cancel reason")
      } else if (mode === "read-error" || mode === "overflow")
        await expect(response.text()).rejects.toThrow()
      else await response.text()
    }
    expect(vi.getTimerCount()).toBe(0)
    if (signal) expect(getEventListeners(signal, "abort")).toHaveLength(0)
    if (source) expect(source.locked).toBe(false)
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(signal?.aborted).toBe(false)
  })

  it("keeps a deadline until an active finite body completes or is cancelled", async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    const request = boundedMcpFetch(100, async (_url, init) => {
      signal = init?.signal ?? undefined
      return new Response(new ReadableStream<Uint8Array>())
    })
    const response = await request("https://example.com/mcp", { method: "POST" })
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(signal?.aborted).toBe(true)
    await response.body?.cancel()
    expect(vi.getTimerCount()).toBe(0)
  })
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
