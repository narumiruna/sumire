import { loadUrlDetailed } from "@narumitw/sumire-url-reader"
import { describe, expect, it, vi } from "vitest"

import { createPublicUrlLoader } from "../src/public-url.js"

vi.mock("@narumitw/sumire-url-reader", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@narumitw/sumire-url-reader")>()),
  loadUrlDetailed: vi.fn(),
}))

describe("public URL deadline defaults", () => {
  it.each([
    [undefined, 3_600],
    [10, 10],
  ])("forwards the remaining budget with override %s", async (override, expectedSeconds) => {
    const load = vi.mocked(loadUrlDetailed).mockResolvedValue({
      content: "x".repeat(12_001),
      loaderId: "httpx",
      contentType: "generic_web",
      downgraded: false,
      attempts: [],
    })
    const timeout = vi.spyOn(AbortSignal, "timeout")
    try {
      const loader = createPublicUrlLoader({ urlContentTimeoutSeconds: override })
      const result = await loader.load("https://8.8.8.8/article")
      expect(timeout).toHaveBeenNthCalledWith(1, expectedSeconds * 1_000)
      const options = load.mock.lastCall?.[1]
      expect(options?.deadlineSeconds).toBeGreaterThan(expectedSeconds - 5)
      expect(options?.deadlineSeconds).toBeLessThanOrEqual(expectedSeconds)
      expect(options?.signal).toBeInstanceOf(AbortSignal)
      expect(result.truncated).toBe(true)
      expect(result.text).toContain("12001 -> 12000 chars")
    } finally {
      timeout.mockRestore()
      load.mockReset()
    }
  })
})
