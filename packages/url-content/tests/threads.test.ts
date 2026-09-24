import { describe, expect, it, vi } from "vitest"

import { UrlContentClient } from "../src/client.js"
import type { LoaderContentError } from "../src/core/errors.js"
import type { ResourceProvider } from "../src/core/resources.js"
import {
  extractThreadsPost,
  extractThreadsSharePost,
  MAX_THREADS_BYTES,
  ThreadsLoader,
} from "../src/loaders/threads.js"
import { parseThreadsTarget } from "../src/sources/applicability.js"

const postUrl = "https://www.threads.com/@ha_haha_1229/post/Ddi8GHWk1ga"
const shareUrl = "https://www.threads.com/share/_mwJv9S32/"
const canonicalMeta =
  '<meta property="og:url" content="https://www.threads.com/&#064;ha_haha_1229/post/Ddi8GHWk1ga">'

function pageHtml(
  options: { description?: string; title?: string; canonical?: string } = {},
): string {
  const canonical = options.canonical ?? canonicalMeta
  const title =
    options.title ?? '<meta property="og:title" content="Hana (&#064;ha_haha_1229) on Threads">'
  const description =
    options.description ??
    '<meta property="og:description" content="&#x5728;&#x53f0;&#x7063;&#x4e0d;&#x80fd;&#x73a9; Polymarket\n\n#&#x5168;&#x57df;&#x8981;&#x8a2d;&#x5b9a;&#x597d;&#x5537;">'
  return `<html><head>${canonical}<link rel="canonical" href="${postUrl}">${title}${description}</head><body>application shell</body></html>`
}

describe("Threads loader", () => {
  it("extracts decoded post metadata instead of the application shell", () => {
    const result = extractThreadsPost(pageHtml(), parseThreadsTarget(postUrl))
    expect(result).toBe(
      [
        "# Hana (@ha_haha_1229)",
        "",
        `- URL: ${postUrl}`,
        "",
        "在台灣不能玩 Polymarket",
        "",
        "#全域要設定好唷",
      ].join("\n"),
    )
    expect(result).not.toContain("application shell")
  })

  it("loads bounded HTML with the mobile user agent that receives post metadata", async () => {
    const fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get("user-agent")).toContain("iPhone")
      expect(headers.get("accept-language")).toBe("en-US,en;q=0.9")
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return new Response(pageHtml(), { headers: { "content-type": "text/html; charset=utf-8" } })
    })
    const resources = { fetch } as unknown as ResourceProvider

    await expect(new ThreadsLoader({ resources }).load(postUrl)).resolves.toContain(
      "在台灣不能玩 Polymarket",
    )
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("resolves a share link through verified metadata using the bounded Threads extractor", async () => {
    const fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("user-agent")).toContain("iPhone")
      return new Response(pageHtml(), { headers: { "content-type": "text/html" } })
    })
    const resources = { fetch } as unknown as ResourceProvider
    const result = await new ThreadsLoader({ resources }).load(shareUrl)
    expect(result).toContain(`- URL: ${postUrl}`)
    expect(result).toContain("在台灣不能玩 Polymarket")
    expect(result).not.toContain("application shell")
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each([
    [
      "error page",
      "<html><title>Threads</title><body>The link's not working or the page is gone.</body></html>",
    ],
    ["title only", "<html><title>Threads</title></html>"],
    [
      "verified title without a description",
      pageHtml({ description: '<meta property="og:description" content="">' }),
    ],
    [
      "credentialed canonical",
      pageHtml().replace(
        `<link rel="canonical" href="${postUrl}">`,
        `<link rel="canonical" href="https://user:password@www.threads.com/@ha_haha_1229/post/Ddi8GHWk1ga">`,
      ),
    ],
    ["missing canonical", pageHtml().replace(`<link rel="canonical" href="${postUrl}">`, "")],
    [
      "different canonical",
      pageHtml().replace(
        `<link rel="canonical" href="${postUrl}">`,
        '<link rel="canonical" href="https://www.threads.com/@other/post/Different">',
      ),
    ],
  ])("rejects a share link with %s", (_name, html) => {
    expect(() => extractThreadsSharePost(html, shareUrl)).toThrowError(
      expect.objectContaining<Partial<LoaderContentError>>({ name: "LoaderContentError" }),
    )
  })

  it("rejects a redirect to a post that conflicts with the returned canonical metadata", () => {
    expect(() =>
      extractThreadsSharePost(
        pageHtml(),
        shareUrl,
        "https://www.threads.com/@other/post/Different",
      ),
    ).toThrow("metadata disagrees")
  })

  it.each([
    "https://www.threads.com/share/",
    "https://www.threads.com/share/%5Fid",
    "https://www.threads.com/share/id/other",
  ])("rejects malformed share links without fetching %s", async (url) => {
    const fetch = vi.fn()
    const resources = { fetch } as unknown as ResourceProvider
    await expect(new ThreadsLoader({ resources }).load(url)).rejects.toThrow(
      "Invalid Threads share link",
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it("rejects a share response that redirects outside the requested Threads post", async () => {
    const response = new Response(pageHtml(), { headers: { "content-type": "text/html" } })
    Object.defineProperty(response, "url", { value: "https://elsewhere.example/other" })
    const resources = { fetch: async () => response } as unknown as ResourceProvider
    await expect(new ThreadsLoader({ resources }).load(shareUrl)).rejects.toThrow(
      "Share link left the requested post",
    )
  })

  it("rejects private redirects and excessive redirects before fetching the post", async () => {
    const resolve = async () => [{ address: "93.184.216.34", family: 4 as const }]
    const privateFetch = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
    )
    const privateClient = new UrlContentClient({
      fetchImplementation: privateFetch,
      resolve,
    }).start()
    try {
      await expect(privateClient.loadUrlDetailed(shareUrl)).rejects.toThrow("Private")
      expect(privateFetch).toHaveBeenCalledOnce()
    } finally {
      await privateClient.close()
    }
    const loopFetch = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: shareUrl } }),
    )
    const loopClient = new UrlContentClient({ fetchImplementation: loopFetch, resolve }).start()
    try {
      await expect(loopClient.loadUrlDetailed(shareUrl)).rejects.toThrow("redirect limit")
      expect(loopFetch).toHaveBeenCalledTimes(6)
    } finally {
      await loopClient.close()
    }
  })

  it("aborts an in-flight share fetch without falling back to generic HTML", async () => {
    const controller = new AbortController()
    const fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })
    })
    const resources = { fetch } as unknown as ResourceProvider
    const pending = new ThreadsLoader({ resources }).load(shareUrl, controller.signal)
    controller.abort(new Error("cancelled"))
    await expect(pending).rejects.toThrow("cancelled")
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("times out a stalled share fetch", async () => {
    const resources = {
      fetch: async (_input: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
        }),
    } as unknown as ResourceProvider
    await expect(new ThreadsLoader({ resources, timeoutMs: 5 }).load(shareUrl)).rejects.toThrow(
      "timed out",
    )
  })

  it.each([postUrl, shareUrl])("rejects oversized responses for %s", async (url) => {
    const resources = {
      fetch: async () =>
        new Response(null, {
          headers: {
            "content-length": String(MAX_THREADS_BYTES + 1),
            "content-type": "text/html",
          },
        }),
    } as unknown as ResourceProvider

    await expect(new ThreadsLoader({ resources }).load(url)).rejects.toThrow(
      `${MAX_THREADS_BYTES} byte limit`,
    )
  })

  it.each([
    {
      name: "missing post text",
      html: pageHtml({ description: '<meta property="og:description" content="">' }),
      message: "too short",
    },
    {
      name: "a different canonical post",
      html: pageHtml({
        canonical:
          '<meta property="og:url" content="https://www.threads.com/&#064;ha_haha_1229/post/OtherPost">',
      }),
      message: "different post",
    },
  ])("rejects $name", ({ html, message }) => {
    expect(() => extractThreadsPost(html, parseThreadsTarget(postUrl))).toThrowError(
      expect.objectContaining<Partial<LoaderContentError>>({
        message: expect.stringContaining(message),
      }),
    )
  })
})
