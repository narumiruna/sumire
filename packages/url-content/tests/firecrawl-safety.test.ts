import { describe, expect, it, vi } from "vitest"

import { LoaderTimeoutError } from "../src/core/errors.js"
import type { ResourceProvider } from "../src/core/resources.js"
import { FirecrawlLoader, MAX_FIRECRAWL_BYTES } from "../src/loaders/firecrawl.js"

function loader(response: Response, timeoutMs = 1_000) {
  return new FirecrawlLoader({
    apiKey: "test-key",
    timeoutMs,
    resources: {
      fetch: async () => response,
      validateUrl: async (target: string | URL) => {
        const url = new URL(target)
        if (url.hostname === "127.0.0.1") throw new Error("Private URL target")
        return url
      },
    } as unknown as ResourceProvider,
  })
}

describe("Firecrawl result safety", () => {
  it("rejects a response declaring more than the byte limit", async () => {
    await expect(
      loader(
        new Response("{}", { headers: { "content-length": String(MAX_FIRECRAWL_BYTES + 1) } }),
      ).load("https://example.com"),
    ).rejects.toThrow("byte limit")
  })

  it("enforces the streamed byte limit even without size metadata", async () => {
    const cancel = vi.fn()
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_FIRECRAWL_BYTES + 1))
        },
        cancel,
      }),
    )
    await expect(loader(response).load("https://example.com")).rejects.toThrow("byte limit")
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("cancels a stalled response body at the request deadline", async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }))
    await expect(loader(response, 5).load("https://example.com")).rejects.toBeInstanceOf(
      LoaderTimeoutError,
    )
    expect(cancel).toHaveBeenCalledOnce()
    expect(response.body?.locked).toBe(false)
  })

  it("cancels unsuccessful API response bodies", async () => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }), { status: 503 })
    await expect(loader(response).load("https://example.com")).rejects.toThrow(
      "Firecrawl API returned HTTP 503",
    )
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each([null, [], "unexpected"])("rejects an invalid API envelope: %j", async (payload) => {
    await expect(loader(Response.json(payload)).load("https://example.com")).rejects.toThrow(
      "invalid response envelope",
    )
  })

  it("rejects reported private final targets", async () => {
    const response = Response.json({
      success: true,
      data: { markdown: "Article", metadata: { url: "http://127.0.0.1/private" } },
    })
    await expect(loader(response).load("https://example.com")).rejects.toThrow("Private URL target")
  })

  it("rejects challenge headings rather than accepting nonempty error pages", async () => {
    const response = Response.json({
      success: true,
      data: { markdown: "# Just a moment...\nChecking your browser" },
    })
    await expect(loader(response).load("https://example.com")).rejects.toThrow("challenge marker")
  })
})
