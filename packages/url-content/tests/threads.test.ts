import { describe, expect, it, vi } from "vitest"

import type { LoaderContentError } from "../src/core/errors.js"
import type { ResourceProvider } from "../src/core/resources.js"
import { extractThreadsPost, MAX_THREADS_BYTES, ThreadsLoader } from "../src/loaders/threads.js"
import { parseThreadsTarget } from "../src/sources/applicability.js"

const postUrl = "https://www.threads.com/@ha_haha_1229/post/Ddi8GHWk1ga"
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
  return `<html><head>${canonical}${title}${description}</head><body>application shell</body></html>`
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

  it("rejects oversized responses", async () => {
    const resources = {
      fetch: async () =>
        new Response(null, {
          headers: {
            "content-length": String(MAX_THREADS_BYTES + 1),
            "content-type": "text/html",
          },
        }),
    } as unknown as ResourceProvider

    await expect(new ThreadsLoader({ resources }).load(postUrl)).rejects.toThrow(
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
