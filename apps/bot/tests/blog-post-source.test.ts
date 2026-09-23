import type { LoadedUrl, PublicUrlLoader } from "@narumitw/sumire-url-tool"
import { describe, expect, it, vi } from "vitest"
import {
  ArticleUrlBudgetError,
  loadArticleSourceUrls,
  TooManyArticleUrlsError,
} from "../src/blog-post/source.js"

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

  it.each([".", ";", "!", "?", ",", "。"])(
    "preserves an explicit URL ending in %s when it is not a prose delimiter",
    async (ending) => {
      const url = `https://example.com/article${ending}`
      const load = vi.fn(async (value: string) => loaded(value, "content"))

      const result = await loadArticleSourceUrls(url, { load }, { maxChars: 100, timeoutMs: 1_000 })

      expect(load).toHaveBeenCalledWith(url, expect.any(Object))
      expect(result[0]?.url).toBe(url)
    },
  )

  it.each([
    ["https://example.com/O'Reilly", "https://example.com/O'Reilly"],
    ["'https://example.com/O'Reilly'", "https://example.com/O'Reilly"],
    ["[來源]('https://example.com/O'Reilly').", "https://example.com/O'Reilly"],
    ["https://example.com/path'", "https://example.com/path'"],
    ["`https://example.com/article`", "https://example.com/article"],
    ["[來源](`https://example.com/article`),", "https://example.com/article"],
    ["`https://example.com/a`b`", "https://example.com/a`b"],
    ["https://example.com/a`b", "https://example.com/a`b"],
    ["https://example.com/path`", "https://example.com/path`"],
    ["「https://example.com/article」", "https://example.com/article"],
    ["“https://example.com/article”！", "https://example.com/article"],
    ["「https://example.com/a」b」", "https://example.com/a」b"],
    ["https://example.com/path」", "https://example.com/path」"],
    ["https://example.com/path”", "https://example.com/path”"],
  ])("preserves URL characters inside %s", async (source, url) => {
    const load = vi.fn(async (value: string) => loaded(value, "content"))
    const result = await loadArticleSourceUrls(
      source,
      { load },
      { maxChars: 100, timeoutMs: 1_000 },
    )

    expect(load).toHaveBeenCalledWith(url, expect.any(Object))
    expect(result[0]?.url).toBe(url)
  })

  it("trims punctuation outside an unmatched Markdown closing delimiter", async () => {
    const load = vi.fn(async (url: string) => loaded(url, "content"))
    const result = await loadArticleSourceUrls(
      "[來源](https://example.com/article!).",
      { load },
      { maxChars: 100, timeoutMs: 1_000 },
    )
    expect(result[0]?.url).toBe("https://example.com/article!")
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

  it("redistributes unused character budget from short URLs to longer sources", async () => {
    const short = "s".repeat(100)
    const long = "l".repeat(10_000)
    const load = vi.fn(async (url: string) => loaded(url, url.endsWith("/short") ? short : long))
    const source = "https://example.com/short https://example.com/long"

    const full = await loadArticleSourceUrls(
      source,
      { load },
      {
        maxChars: 12_000,
        timeoutMs: 1_000,
      },
    )
    expect(full.map(({ text, truncated }) => [text.length, truncated])).toEqual([
      [100, false],
      [10_000, false],
    ])

    const bounded = await loadArticleSourceUrls(
      source,
      { load },
      {
        maxChars: 6_000,
        timeoutMs: 1_000,
      },
    )
    expect(bounded.map(({ text, truncated }) => [text.length, truncated])).toEqual([
      [100, false],
      [5_900, true],
    ])
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
