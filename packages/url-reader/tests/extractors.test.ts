import { describe, expect, it } from "vitest"

import { LoaderContentError } from "../src/core/errors.js"
import { ensureUsableContent } from "../src/loaders/content-guard.js"
import { extractLtnArticleText, extractNewsArticleText } from "../src/loaders/news.js"
import { extractPttPost } from "../src/loaders/ptt.js"
import {
  extractArticleBodyFromJsonLd,
  extractFirstTagSubtree,
  genericHtmlToMarkdown,
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
      </head><body><template>Hidden application shell</template>
      <main><h1>Model guidance</h1><p>Read this documentation.</p>
      <pre><code>&lt;script&gt;visible example&lt;/script&gt;</code></pre></main></body></html>`
    const markdown = htmlToMarkdown(html)

    expect(markdown.startsWith("# Model guidance")).toBe(true)
    expect(markdown.slice(0, 12_000)).toContain("Read this documentation.")
    expect(markdown).toContain("<script>visible example</script>")
    expect(markdown).not.toContain("window.prefetch")
    expect(markdown).not.toContain(".navigation")
    expect(markdown).not.toContain("Hidden application shell")
  })

  it("retains a readable document inside a no-JavaScript fallback", () => {
    const html =
      "<noscript><article><h1>No-JS guide</h1><p>Readable fallback body.</p></article></noscript>"
    expect(htmlToMarkdown(html)).toBe("# No-JS guide\nReadable fallback body.")
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

  it("keeps the main title and body before a large navigation budget", () => {
    const html = `<nav>${"Site navigation ".repeat(1_000)}</nav>
      <main><button>Copy page</button><header><h1>Persistent agents</h1><p>Article summary.</p></header>
      <nav>Table of contents</nav><article><p>Opening body.</p>
      <header><h2>Boundaries</h2></header><p>Closing body.</p>
      <aside>Important qualification.</aside><footer>Article attribution.</footer></article></main>
      <footer>Site footer</footer>`

    expect(genericHtmlToMarkdown(html)).toBe(
      "# Persistent agents\nArticle summary.\nOpening body.\n## Boundaries\nClosing body.\nImportant qualification.\nArticle attribution.",
    )
    expect(genericHtmlToMarkdown(html).length).toBeLessThan(12_000)
    // Keep the lower-level converter compatible with source-specific callers.
    expect(htmlToMarkdown(html)).toContain("Site navigation")
    expect(htmlToMarkdown(html)).toContain("Copy page")
  })

  it.each([
    [
      "main before unrelated article cards",
      "<article>Unrelated card.</article><main><h1>Guide</h1><p>Body.</p></main>",
      "# Guide\nBody.",
    ],
    [
      "article cards inside navigation before the real article",
      "<nav><article>Navigation card.</article></nav><article><h1>Guide</h1>Body.</article>",
      "# Guide\nBody.",
    ],
    [
      "all standalone article cards in order",
      "<nav>Site menu</nav><article><header><h1>First</h1></header><p>One.</p></article><article><h2>Second</h2><p>Two.</p></article>",
      "# First\nOne.\n## Second\nTwo.",
    ],
    [
      "all outer main regions in order",
      "<main><h1>First</h1><article>One.</article></main><main><h2>Second</h2>Two.</main>",
      "# First\nOne.\n## Second\nTwo.",
    ],
    [
      "an article header outside a nested main",
      "<article><header><h1>Guide</h1></header><main>Body.</main></article>",
      "# Guide\nBody.",
    ],
    [
      "nested articles without duplicates",
      "<article><h1>Guide</h1><article>Nested body.</article></article>",
      "# Guide\nNested body.",
    ],
    [
      "standalone articles after empty main regions",
      "<main><script>noise()</script><nav>Menu</nav><button>Copy</button></main><article><h1>Guide</h1>Body.</article>",
      "# Guide\nBody.",
    ],
    [
      "a later readable main after an empty main",
      "<main><style>noise</style></main><main><h1>Guide</h1>Body.</main>",
      "# Guide\nBody.",
    ],
    [
      "readable noscript content",
      "<noscript><article><h1>No-JS guide</h1><p>Fallback body.</p></article></noscript>",
      "# No-JS guide\nFallback body.",
    ],
    [
      "literal code examples",
      "<main><h1>Guide</h1><pre><code>&lt;nav&gt;example&lt;/nav&gt; &lt;button&gt;literal&lt;/button&gt;</code></pre></main>",
      "# Guide\n```\n<nav>example</nav> <button>literal</button>\n```",
    ],
    [
      "no semantic region",
      "<header>Page header</header><nav>Menu</nav><div><h1>Guide</h1>Body.</div>",
      "Page header\nMenu\n# Guide\nBody.",
    ],
    [
      "no usable semantic region",
      "<main><script>noise()</script><template>Hidden</template></main><p>Fallback body.</p>",
      "Fallback body.",
    ],
    [
      "hidden template regions before the real body",
      "<template><main>Hidden body.</main></template><article><h1>Guide</h1>Body.</article>",
      "# Guide\nBody.",
    ],
    [
      "only non-visible assets",
      "<script>noise()</script><style>noise</style><template><article>Hidden</article></template>",
      "",
    ],
  ])("selects generic content with %s", (_name, html, expected) => {
    expect(genericHtmlToMarkdown(html)).toBe(expected)
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
