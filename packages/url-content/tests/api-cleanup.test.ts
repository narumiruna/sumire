import { afterEach, describe, expect, it, vi } from "vitest"
import { loadUrlDetailed } from "../src/api.js"
import { UrlContentClient } from "../src/client.js"

const result = {
  content: "article",
  loaderId: "httpx",
  contentType: "generic_web",
  downgraded: false,
  attempts: [],
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe("one-shot client cleanup", () => {
  it("does not replace the original interruption with a cleanup error", async () => {
    const reason = new DOMException("cancelled", "AbortError")
    vi.spyOn(UrlContentClient.prototype, "loadUrlDetailed").mockRejectedValue(reason)
    vi.spyOn(UrlContentClient.prototype, "close").mockRejectedValue(new Error("cleanup failed"))
    await expect(loadUrlDetailed("https://example.com")).rejects.toBe(reason)
  })

  it("bounds waiting for stalled cleanup to five seconds", async () => {
    vi.useFakeTimers()
    const reason = new DOMException("expired", "TimeoutError")
    vi.spyOn(UrlContentClient.prototype, "loadUrlDetailed").mockRejectedValue(reason)
    vi.spyOn(UrlContentClient.prototype, "close").mockImplementation(
      async () => new Promise(() => {}),
    )
    const pending = loadUrlDetailed("https://example.com").catch((error) => error)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(await pending).toBe(reason)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("still reports cleanup failure after a successful load", async () => {
    vi.spyOn(UrlContentClient.prototype, "loadUrlDetailed").mockResolvedValue(result)
    vi.spyOn(UrlContentClient.prototype, "close").mockRejectedValue(new Error("cleanup failed"))
    await expect(loadUrlDetailed("https://example.com")).rejects.toThrow("cleanup failed")
  })
})
