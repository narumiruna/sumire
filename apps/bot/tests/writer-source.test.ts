import type { LoadedUrl, PublicUrlLoader } from "@narumitw/sumire-url-tool"
import { describe, expect, it, vi } from "vitest"
import {
  ArticleUrlBudgetError,
  loadArticleSourceUrls,
  TooManyArticleUrlsError,
} from "../src/writer/source.js"

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
      "[來源](https://example.com/one), （https://example.com/two）。 https://example.com/one",
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

  it("keeps balanced delimiters in URLs and drops only unmatched closers", async () => {
    const load = vi.fn(async (url: string) => loaded(url, "content"))
    const result = await loadArticleSourceUrls(
      "https://example.com/a(b)c)) https://example.com/[one]] https://example.com/（二））",
      { load },
      { maxChars: 100, timeoutMs: 1_000 },
    )
    expect(result.map(({ url }) => url)).toEqual([
      "https://example.com/a(b)c",
      "https://example.com/[one]",
      "https://example.com/（二）",
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

  it("keeps the count limit at four even with a tiny character budget", async () => {
    const load = vi.fn(async (url: string) => loaded(url, "abcd"))
    await expect(
      loadArticleSourceUrls(
        "https://example.com/1 https://example.com/2",
        { load },
        {
          maxChars: 1,
          timeoutMs: 1_000,
        },
      ),
    ).rejects.toBeInstanceOf(ArticleUrlBudgetError)
    expect(load).not.toHaveBeenCalled()

    const result = await loadArticleSourceUrls(
      "https://example.com/1 https://example.com/2 https://example.com/3",
      { load },
      { maxChars: 3, timeoutMs: 1_000 },
    )
    expect(result.map(({ text }) => text)).toEqual(["a", "a", "a"])
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

  it("stops waiting when a caller cancels even if a loader ignores abort", async () => {
    const controller = new AbortController()
    const load: PublicUrlLoader["load"] = vi.fn(async () => new Promise<LoadedUrl>(() => {}))
    const pending = loadArticleSourceUrls(
      "https://example.com/slow",
      { load },
      {
        maxChars: 12_000,
        timeoutMs: 1_000,
        signal: controller.signal,
      },
    )
    controller.abort()
    await expect(pending).rejects.toThrow()
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
