import type { LoadedUrl, PublicUrlLoader } from "@narumitw/sumire-url-tool"
import { describe, expect, it, vi } from "vitest"
import { loadArticleSourceUrls, TooManyArticleUrlsError } from "../src/writer/source.js"

function loaded(url: string, text: string) {
  return {
    url,
    finalUrl: url,
    source: "built-in" as const,
    contentType: "text/plain",
    text,
    truncated: false,
  }
}

describe("article source URLs", () => {
  it("loads distinct URLs concurrently and preserves source order", async () => {
    const pending = new Map<string, (value: ReturnType<typeof loaded>) => void>()
    const load = vi.fn(
      (url: string) =>
        new Promise<ReturnType<typeof loaded>>((resolve) => pending.set(url, resolve)),
    )
    const result = loadArticleSourceUrls(
      "https://example.com/one, https://example.com/two https://example.com/one",
      { load },
      { maxChars: 8, timeoutMs: 1_000 },
    )

    expect(load.mock.calls.map(([url]) => url)).toEqual([
      "https://example.com/one",
      "https://example.com/two",
    ])
    pending.get("https://example.com/two")?.(loaded("https://example.com/two", "abcdef"))
    pending.get("https://example.com/one")?.(loaded("https://example.com/one", "123456"))
    await expect(result).resolves.toEqual([
      { url: "https://example.com/one", text: "1234", truncated: true },
      { url: "https://example.com/two", text: "abcd", truncated: true },
    ])
  })

  it("rejects more than four URLs without fetching anything", async () => {
    const load = vi.fn(async (url: string) => loaded(url, "unused"))
    await expect(
      loadArticleSourceUrls(
        Array.from({ length: 5 }, (_, i) => `https://example.com/${i}`).join(" "),
        { load },
        { maxChars: 12_000, timeoutMs: 1_000 },
      ),
    ).rejects.toBeInstanceOf(TooManyArticleUrlsError)
    expect(load).not.toHaveBeenCalled()
  })

  it("aborts remaining loads when one source fails", async () => {
    let pendingSignal: AbortSignal | undefined
    const load: PublicUrlLoader["load"] = vi.fn(async (url, options) => {
      if (url.endsWith("/bad")) throw new Error("unavailable")
      pendingSignal = options?.signal
      return new Promise<LoadedUrl>(() => {})
    })
    await expect(
      loadArticleSourceUrls(
        "https://example.com/bad https://example.com/pending",
        { load },
        {
          maxChars: 12_000,
          timeoutMs: 1_000,
        },
      ),
    ).rejects.toThrow("unavailable")
    expect(pendingSignal?.aborted).toBe(true)
  })

  it("enforces a single deadline even if a URL loader ignores abort", async () => {
    const load: PublicUrlLoader["load"] = vi.fn(async () => new Promise<LoadedUrl>(() => {}))
    await expect(
      loadArticleSourceUrls(
        "https://example.com/slow",
        { load },
        { maxChars: 12_000, timeoutMs: 10 },
      ),
    ).rejects.toThrow()
  })
})
