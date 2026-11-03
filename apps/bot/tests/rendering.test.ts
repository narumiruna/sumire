import { describe, expect, it } from "vitest"

import {
  sanitizeTelegramText,
  telegramHtmlChunks,
  telegramVisibleText,
  trimUrl,
} from "../src/telegram/rendering.js"

describe("Telegram rendering", () => {
  it("renders basic Markdown as Telegram HTML and escapes unsafe markup", () => {
    expect(telegramHtmlChunks("# Title\n**bold** `<tag>`\nhttps://example.test/a?x=1&y=2")).toEqual(
      [
        '<b>Title</b>\n<b>bold</b> <code>&lt;tag&gt;</code>\n<a href="https://example.test/a?x=1&amp;y=2">https://example.test/a?x=1&amp;y=2</a>',
      ],
    )
  })

  it("does not interpret Markdown markers inside generated links", () => {
    expect(telegramHtmlChunks("https://example.test/a**b**c")).toEqual([
      '<a href="https://example.test/a**b**c">https://example.test/a**b**c</a>',
    ])
  })

  it("compares Telegram-visible text rather than generated HTML markup", () => {
    expect(telegramVisibleText("# Title\n**bold** `<tag>`\nhttps://example.test/a?x=1&y=2")).toBe(
      "Title\nbold <tag>\nhttps://example.test/a?x=1&y=2",
    )
    expect(telegramVisibleText("文字 &lt;b&gt; <b>標籤</b>")).toBe("文字 &lt;b&gt; <b>標籤</b>")
  })

  it("chunks by Unicode code point and strips disallowed controls", () => {
    expect(telegramHtmlChunks("😀😀😀", 2)).toEqual(["😀😀", "😀"])
    expect(sanitizeTelegramText("a\u0000b\r\nc")).toBe("ab\nc")
  })

  it("trims punctuation from URLs", () => {
    expect(trimUrl("https://example.test/path。")).toBe("https://example.test/path")
  })
})

describe("native Telegram rich text", () => {
  it.each([
    ["**粗體 *斜體* ~~刪除~~**", "<b>粗體 <i>斜體</i> <s>刪除</s></b>"],
    ["__粗體__ _斜體_", "<b>粗體</b> <i>斜體</i>"],
    ["中文字**「強調」**中文字", "中文字<b>「強調」</b>中文字"],
    ["# **標題**", "<b>標題</b>"],
    ["**粗體 `code` 繼續**", "<b>粗體 </b><code>code</code><b> 繼續</b>"],
    [
      "> 引用 **重點**\n> 第二行\n\n結尾",
      "<blockquote>引用 <b>重點</b>\n第二行</blockquote>\n\n結尾",
    ],
    ["> 第一層\n>> 第二層", "<blockquote>第一層\n第二層</blockquote>"],
    ["- 第一項\n- 第二項\n  - 子項", "• 第一項\n• 第二項\n  • 子項"],
    ["3. one\n4. two", "3. one\n4. two"],
    ["- [x] 完成\n- [ ] 待辦", "• [x] 完成\n• [ ] 待辦"],
    [
      '```ts\nconst a = "<b>"\n```',
      '<pre><code class="language-ts">const a = "&lt;b&gt;"</code></pre>',
    ],
    ["```\n**not bold** <script>\n```", "<pre>**not bold** &lt;script&gt;</pre>"],
    ["<b>raw HTML</b>", "&lt;b&gt;raw HTML&lt;/b&gt;"],
    ["<script>alert(1)</script>", "&lt;script&gt;alert(1)&lt;/script&gt;"],
    ["\\*literal\\*", "*literal*"],
  ])("renders %s using only supported, escaped markup", (source, expected) => {
    expect(telegramHtmlChunks(source)).toEqual([expected])
  })

  it("renders named links, titles, balanced URL parentheses, and reference links", () => {
    expect(telegramHtmlChunks('[文件](https://example.test/a_(b)?x=1&y=2 "標題")')).toEqual([
      '<a href="https://example.test/a_(b)?x=1&amp;y=2">文件</a>',
    ])
    expect(telegramHtmlChunks("[文件][ref]\n\n[ref]: https://example.test/path")).toEqual([
      '<a href="https://example.test/path">文件</a>\n\n',
    ])
    expect(telegramHtmlChunks("[下載](https://example.test/a%20b)")).toEqual([
      '<a href="https://example.test/a%20b">下載</a>',
    ])
  })

  it("keeps code entities outside links and quote formatting", () => {
    expect(telegramHtmlChunks("[**粗體** `code`](https://example.test/path)")).toEqual([
      '<a href="https://example.test/path"><b>粗體</b> code</a>',
    ])
    expect(telegramHtmlChunks("> 引用\n>\n> ```ts\n> let a = 1\n> ```")).toEqual([
      '<blockquote>引用\n\n</blockquote><pre><code class="language-ts">let a = 1</code></pre>',
    ])
  })

  it.each([
    "javascript:alert(1)",
    "data:text/html,bad",
    "file:///etc/passwd",
    "tg://user?id=123",
    "//example.test/path",
    "./README.md",
    "https://user:password@example.test/path",
  ])("does not activate an unsafe or ambiguous destination: %s", (href) => {
    expect(telegramHtmlChunks(`[文字](${href})`)).toEqual(["文字"])
  })

  it("allows mailto links without exposing raw attributes", () => {
    expect(telegramHtmlChunks("[聯絡](mailto:hello@example.test)")).toEqual([
      '<a href="mailto:hello@example.test">聯絡</a>',
    ])
    const [html] = telegramHtmlChunks('[文字](https://example.test/"onclick="alert(1))')
    expect(html).not.toContain(' onclick="')
    expect(html).not.toContain("<script>")
    expect(html).toContain("%22")
  })

  it("does not turn arbitrary language metadata into HTML attributes", () => {
    expect(telegramHtmlChunks("```<script>\nvalue\n```")).toEqual(["<pre>value</pre>"])
  })

  it("renders images as links without fetching or embedding them", () => {
    expect(telegramHtmlChunks("![範例圖](https://example.test/image.png)")).toEqual([
      '<a href="https://example.test/image.png">範例圖</a>',
    ])
  })

  it("preserves unsupported tables as escaped monospace instead of unsupported HTML", () => {
    const table = "| 名稱 | 數值 |\n| --- | --- |\n| <b>A</b> | 1 |"
    expect(telegramHtmlChunks(table)).toEqual([
      "<pre>| 名稱 | 數值 |\n| --- | --- |\n| &lt;b&gt;A&lt;/b&gt; | 1 |</pre>",
    ])
    expect(telegramVisibleText(table)).toBe(table)
  })

  it("uses actual display text for progress and reply-checkpoint comparisons", () => {
    expect(
      telegramVisibleText("# 標題\n[文件](https://example.test) *斜體* ~~刪除~~\n> 引用"),
    ).toBe("標題\n文件 斜體 刪除\n引用")
    expect(telegramVisibleText("😀 [連結](https://example.test?a=1&b=2) `&lt;` <tag>")).toBe(
      "😀 連結 &lt; <tag>",
    )
  })

  it("keeps raw HTML and escaped entity spellings literal", () => {
    expect(telegramVisibleText("&lt;b&gt; <b>標籤</b> &#60;script&#62;")).toBe(
      "&lt;b&gt; <b>標籤</b> &#60;script&#62;",
    )
  })

  it.each([
    ["&lt;script&gt; &amp; &quot;", "&amp;lt;script&amp;gt; &amp;amp; &amp;quot;"],
    ["&#60;script&#62; &#34;", "&amp;#60;script&amp;#62; &amp;#34;"],
    ["&#x3c;script&#X3E; &#x22;", "&amp;#x3c;script&amp;#X3E; &amp;#x22;"],
    ["&#38; & bare &amp; &#128512;", "&amp;#38; &amp; bare &amp;amp; &amp;#128512;"],
  ])("preserves entity spellings as escaped literal text: %s", (source, html) => {
    expect(telegramVisibleText(source)).toBe(source)
    expect(telegramHtmlChunks(source)).toEqual([html])
  })

  it("preserves literal entities inside nested formatting and link labels", () => {
    const source =
      "- **&lt;b&gt; *&#60;script&#62;* [&#x3C;img src=x onerror=alert(1)&#x3E;](https://example.test)**"
    expect(telegramVisibleText(source)).toBe(
      "• &lt;b&gt; &#60;script&#62; &#x3C;img src=x onerror=alert(1)&#x3E;",
    )
    expect(telegramHtmlChunks(source)).toEqual([
      '• <b>&amp;lt;b&amp;gt; <i>&amp;#60;script&amp;#62;</i> <a href="https://example.test/">&amp;#x3C;img src=x onerror=alert(1)&amp;#x3E;</a></b>',
    ])
  })

  it("still removes Markdown escape backslashes next to literal entities", () => {
    expect(telegramVisibleText("\\* &#60; \\&lt;")).toBe("* &#60; &lt;")
    expect(telegramHtmlChunks("\\* &#60; \\&lt;")).toEqual(["* &amp;#60; &amp;lt;"])
  })

  it("retains punctuation outside automatic links", () => {
    expect(telegramHtmlChunks("https://example.test/path。\nhttps://example.test/path！")).toEqual([
      '<a href="https://example.test/path">https://example.test/path</a>。\n<a href="https://example.test/path">https://example.test/path</a>！',
    ])
  })

  it("sanitizes invalid Unicode and controls without corrupting emoji", () => {
    expect(telegramVisibleText("😀\ud800\u0000\r\n**完整**")).toBe("😀\n完整")
  })
})

describe("rich text edge cases", () => {
  it.each(["[ref]: https://example.test/path", "```\n```", ">"])(
    "does not produce an empty Telegram payload for %s",
    (source) => {
      expect(telegramHtmlChunks(source)[0]?.length).toBeGreaterThan(0)
      expect(telegramVisibleText(source).trim().length).toBeGreaterThan(0)
    },
  )

  it("keeps line breaks and whitespace around formatted blocks", () => {
    expect(telegramHtmlChunks("# 標題\n\n*內容*\n\n")).toEqual(["<b>標題</b>\n\n<i>內容</i>\n\n"])
  })
})

describe("automatic link boundaries", () => {
  it.each(["https://en.wikipedia.org/wiki/Function_(mathematics)"])(
    "preserves balanced parentheses in %s",
    (url) => {
      expect(trimUrl(`${url}。`)).toBe(url)
      expect(telegramHtmlChunks(url)).toEqual([`<a href="${url}">${url}</a>`])
    },
  )

  it.each([
    "https://user:pass@example.test/path。",
    "http://user@example.test/path！",
    "https://example.test:99999/path。",
  ])("preserves complete text when rejecting an automatic link: %s", (source) => {
    expect(telegramHtmlChunks(source)).toEqual([source])
    expect(telegramVisibleText(source)).toBe(source)
  })

  it("trims surrounding punctuation without removing balanced URL delimiters", () => {
    expect(trimUrl("https://example.test/a_(b))。")).toBe("https://example.test/a_(b)")
  })
})
