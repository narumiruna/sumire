import { describe, expect, it } from "vitest"
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

  it("passes SSE to Pi's event-bounded reader and keeps redirect and deadline controls", async () => {
    const request = boundedMcpFetch(1000, async (_url, init) => {
      expect(init?.redirect).toBe("error")
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return new Response("data: {}\n\n", { headers: { "content-type": "text/event-stream" } })
    })
    expect(await (await request("https://example.com/mcp")).text()).toBe("data: {}\n\n")
    expect(MCP_MAX_MESSAGE_BYTES).toBe(8_000_000)
  })
})
