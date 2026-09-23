import { describe, expect, it } from "vitest"

import { LoaderContentError } from "../src/core/errors.js"
import { ensureUsableContent } from "../src/loaders/content-guard.js"
import { extractLtnArticleText, extractNewsArticleText } from "../src/loaders/news.js"
import { extractPttPost } from "../src/loaders/ptt.js"
import {
  extractArticleBodyFromJsonLd,
  extractFirstTagSubtree,
  htmlToMarkdown,
} from "../src/loaders/utils.js"

const url = "https://example.com/article"

describe("HTML extraction", () => {
  it("normalizes markdown while keeping link text and dropping images", () => {
    expect(
      htmlToMarkdown("<h1>Hello</h1><p>Read <a href='/x'>this</a><img alt='ignored' src='x'></p>"),
    ).toBe("# Hello\nRead this")
  })

  it("drops non-visible page assets before the readable document text", () => {
    const html = `<html><head>
      <script>${"window.prefetch = 'noise';".repeat(650)}</script>
      <style>${".navigation { color: red; }".repeat(650)}</style>
      </head><body><noscript>Enable JavaScript to continue</noscript>
      <template>Hidden application shell</template>
      <main><h1>Model guidance</h1><p>Read this documentation.</p>
      <pre><code>&lt;script&gt;visible example&lt;/script&gt;</code></pre></main></body></html>`
    const markdown = htmlToMarkdown(html)

    expect(markdown.startsWith("# Model guidance")).toBe(true)
    expect(markdown.slice(0, 12_000)).toContain("Read this documentation.")
    expect(markdown).toContain("<script>visible example</script>")
    expect(markdown).not.toContain("window.prefetch")
    expect(markdown).not.toContain(".navigation")
    expect(markdown).not.toContain("Enable JavaScript")
    expect(markdown).not.toContain("Hidden application shell")
  })

  it("returns empty content for a page with only non-visible assets", () => {
    expect(htmlToMarkdown("<script>noise()</script><style>body { color: red }</style>")).toBe("")
  })

  it("extracts only the first requested subtree and removes ignored descendants", () => {
    const html =
      "<header>menu</header><main><p>&lt;literal&gt;</p><script>bad()</script></main><footer>end</footer>"
    const extracted = extractFirstTagSubtree(html, ["main"])
    expect(extracted).toContain("&lt;literal&gt;")
    expect(extracted).not.toContain("bad()")
    expect(extracted).not.toContain("menu")
  })

  it("finds nested JSON-LD article bodies", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ "@graph": [{ articleBody: " A  body\n line " }] })}</script>`
    expect(extractArticleBodyFromJsonLd(html)).toBe("A  body\nline")
    expect(extractNewsArticleText(html, url, "NewsLoader")).toBe("A  body\nline")
  })

  it("requires article-specific markup for BBC and CNN extraction", () => {
    expect(
      extractNewsArticleText("<article><p>Article body</p></article>", url, "NewsLoader"),
    ).toBe("Article body")
    expect(() =>
      extractNewsArticleText(
        "<main><h1>Sign in</h1><p>Login required</p></main>",
        url,
        "NewsLoader",
      ),
    ).toThrow("Could not find article body")
    expect(() =>
      extractNewsArticleText("<html><body>Blocker</body></html>", url, "NewsLoader"),
    ).toThrow("Could not find article body")
  })

  it("extracts only a PTT post body", () => {
    expect(extractPttPost('<div id="main-content"><p>Post body</p></div>', url)).toBe("Post body")
    expect(() => extractPttPost("<main>Board listing</main>", url)).toThrow(
      "Could not find PTT post body",
    )
  })

  it("extracts LTN's article div and removes advertising subtrees", () => {
    const html =
      '<div class="text boxTitle boxText"><p>Lead</p><div id="ad-1">Ad</div><p>Body</p></div>'
    const result = extractLtnArticleText(html, url, "LTNLoader")
    expect(result).toContain("Lead")
    expect(result).toContain("Body")
    expect(result).not.toContain("Ad")
  })

  it("rejects empty and challenge pages but permits short real content", () => {
    expect(() => ensureUsableContent("ok", { loaderName: "test", url })).not.toThrow()
    expect(() => ensureUsableContent("", { loaderName: "test", url })).toThrow(LoaderContentError)
    expect(() =>
      ensureUsableContent("# Just a moment...\nbody", { loaderName: "test", url }),
    ).toThrow(LoaderContentError)
  })
})
