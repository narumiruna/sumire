import { describe, expect, it } from "vitest"

import { buildBlogPostPrompt } from "../src/blog-post/prompt.js"

describe("blog post prompt", () => {
  it("wraps untrusted source context with blog post constraints", () => {
    const prompt = buildBlogPostPrompt("  原始內容 https://example.com/article  ")

    expect(prompt).toContain("written entirely in 台灣正體中文")
    expect(prompt).toContain("Preserve all materially important information")
    expect(prompt).toContain("Do not add or infer facts")
    expect(prompt).toContain("use load_public_url")
    expect(prompt).toContain("Do not call publish_markdown_to_morsel")
    expect(prompt).toContain("exactly one relevant emoji")
    expect(prompt).toContain("complete article below 5,000 characters")
    expect(prompt).toContain(
      '<source_context trust="untrusted">\n原始內容 https://example.com/article\n</source_context>',
    )
  })

  it("uses preloaded URLs without asking Pi to fetch the same content again", () => {
    const prompt = buildBlogPostPrompt("https://example.com/article", [
      { url: "https://example.com/article", text: "文章內容", truncated: false },
    ])

    expect(prompt).toContain("do not load those URLs again")
    expect(prompt).toContain('<loaded_url_content trust="untrusted">')
    expect(prompt).toContain('"text":"文章內容"')
  })
})
