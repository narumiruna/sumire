import type { RichBlock, RichText } from "grammy/types"
import { describe, expect, it } from "vitest"
import { richMessageHasMention, richMessageText } from "../src/telegram/rich-message.js"

const cell = (text: RichText) => ({ text, align: "left" as const, valign: "top" as const })

const mention = { type: "mention" as const, text: "@Test_Bot", username: "Test_Bot" }

describe("native Rich Message projection", () => {
  it("preserves text, nested formatting, code, links and math without executing markup", () => {
    expect(
      richMessageText([
        { type: "heading", size: 1, text: { type: "bold", text: "Title" } },
        {
          type: "paragraph",
          text: [
            "Read ",
            { type: "url", text: "docs", url: "https://example.test" },
            " ",
            { type: "custom_emoji", custom_emoji_id: "1", alternative_text: "🌸" },
          ],
        },
        { type: "pre", text: "<script>hello</script>", language: "html" },
        { type: "mathematical_expression", expression: "x^2" },
      ]),
    ).toBe("Title\nRead docs (https://example.test) 🌸\n<script>hello</script>\nx^2")
  })
  it("reads tables, list checkboxes and nested details without discarding their contents", () => {
    expect(
      richMessageText([
        {
          type: "table",
          cells: [
            [cell("A"), cell("B")],
            [cell({ type: "italic", text: "1" }), cell("2")],
          ],
          caption: "Data",
        },
        {
          type: "details",
          summary: "More",
          blocks: [
            {
              type: "list",
              items: [
                {
                  label: "•",
                  has_checkbox: true,
                  is_checked: true,
                  blocks: [{ type: "paragraph", text: "done" }],
                },
                {
                  label: "2.",
                  blocks: [
                    {
                      type: "blockquote",
                      blocks: [{ type: "paragraph", text: "next" }],
                      credit: "Alice",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]),
    ).toBe("A\tB\n1\t2\nData\nMore\n[x] done\n2. next\nAlice")
  })
  it("retains hidden quote details in reply context whether collapsed or expanded", () => {
    const details: RichBlock = {
      type: "details",
      summary: "查看完整名稱與詳細報價",
      blocks: [
        { type: "paragraph", text: { type: "bold", text: "0050 元大台灣50" } },
        { type: "paragraph", text: "開盤 101.55 · 最高 101.65 · 最低 97.70" },
        { type: "paragraph", text: "成交量 239,424" },
      ],
    }
    const blocks: RichBlock[] = [
      { type: "table", cells: [[cell("0050"), cell("97.78"), cell("-2.81%")]] },
      details,
      { type: "paragraph", text: "TWD｜TWSE" },
    ]
    const expected =
      "0050\t97.78\t-2.81%\n查看完整名稱與詳細報價\n0050 元大台灣50\n開盤 101.55 · 最高 101.65 · 最低 97.70\n成交量 239,424\nTWD｜TWSE"
    expect(richMessageText(blocks)).toBe(expected)
    details.is_open = true
    expect(richMessageText(blocks)).toBe(expected)
  })

  it("retains captions and credits without treating received media as downloaded content", () => {
    expect(
      richMessageText([
        { type: "photo", photo: [], caption: { text: "Image caption", credit: "Photographer" } },
        { type: "divider" },
        { type: "anchor", name: "not-content" },
      ]),
    ).toBe("Image caption\nPhotographer")
  })
})

describe("native structured mentions", () => {
  it("matches case-insensitive username mentions in nested blocks and tables", () => {
    const blocks: RichBlock[] = [
      {
        type: "details",
        summary: "More",
        blocks: [{ type: "table", cells: [[cell({ type: "bold", text: mention })]] }],
      },
    ]
    expect(richMessageHasMention(blocks, 999, "test_bot")).toBe(true)
    expect(richMessageHasMention(blocks, 999, "other_bot")).toBe(false)
  })
  it("matches user-ID mentions by the ID, not the user-controlled label", () => {
    const blocks: RichBlock[] = [
      {
        type: "paragraph",
        text: {
          type: "text_mention",
          text: "anything",
          user: { id: 999, is_bot: true, first_name: "Anything" },
        },
      },
    ]
    expect(richMessageHasMention(blocks, 999, "test_bot")).toBe(true)
    expect(richMessageHasMention(blocks, 998, "test_bot")).toBe(false)
  })
  it("does not ping for plain text, URL metadata, inline code or preformatted examples", () => {
    const blocks: RichBlock[] = [
      { type: "paragraph", text: "@test_bot" },
      {
        type: "paragraph",
        text: { type: "url", text: "example", url: "https://example.test/@test_bot" },
      },
      { type: "paragraph", text: { type: "code", text: mention } },
      { type: "pre", text: mention },
    ]
    expect(richMessageHasMention(blocks, 999, "test_bot")).toBe(false)
  })
})
