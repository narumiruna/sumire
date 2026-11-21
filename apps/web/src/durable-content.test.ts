import type { DurableEntryItem } from "@narumitw/sumire-contracts"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import { EntryContent } from "./durable-inspector.js"
import { type Locale, setLocale } from "./i18n.js"

afterEach(() => setLocale("en"))

const untrusted = '<img src="https://untrusted.invalid/image" onerror="alert(1)">'
const render = (content: NonNullable<DurableEntryItem["content"]>) =>
  renderToStaticMarkup(createElement(EntryContent, { content }))

describe("Durable entry content", () => {
  it.each([
    ["zh-TW", "工具呼叫", "助理", "已記錄錯誤"],
    ["ja", "ツール呼び出し", "アシスタント", "記録されたエラー"],
  ] satisfies [Locale, string, string, string][])(
    "localizes reader labels in %s without changing stored content",
    (locale, call, role, error) => {
      setLocale(locale)
      const html = render({
        truncated: false,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "call-42", name: "read_file", arguments: '{"path":"User"}' },
            ],
          },
          {
            role: "toolResult",
            isError: true,
            content: [{ type: "text", text: "Recorded error: raw tool output" }],
          },
        ],
      })
      expect(html).toContain(`aria-label="${call}"`)
      expect(html).toContain('class="durable-tool-call"')
      expect(html).toContain(role)
      expect(html).toContain(error)
      expect(html).toContain("Recorded error: raw tool output")
      expect(html).toContain("read_file")
      expect(html).toContain("call-42")
      expect(html).toContain("{&quot;path&quot;:&quot;User&quot;}")
    },
  )

  it("renders roles, text, thinking, tool calls, results, and omitted images literally", () => {
    const html = render({
      truncated: false,
      messages: [
        { role: "system", content: [{ type: "text", text: untrusted }] },
        { role: "user", content: [{ type: "image", mimeType: "image/png" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: untrusted },
            { type: "toolCall", id: untrusted, name: untrusted, arguments: '{"partial":' },
          ],
        },
        {
          role: "toolResult",
          toolName: untrusted,
          toolCallId: "call-1",
          isError: true,
          content: [{ type: "text", text: untrusted }],
        },
        { role: "toolResult", isError: false, content: [] },
        { role: "toolResult", content: [] },
      ],
    })
    expect(html).toContain("System")
    expect(html).toContain("User")
    expect(html).toContain("Assistant")
    expect(html).toContain("Tool result")
    expect(html).toContain("<details><summary>Thinking</summary>")
    expect(html).not.toContain("<details open")
    expect(html).toContain("&lt;img")
    expect(html).not.toMatch(/<(img|iframe|script)\b|<[^>]*\b(href|src)=/)
    expect(html).toContain("Image omitted · image/png. Image bytes are not sent.")
    expect(html).toContain("Tool name")
    expect(html).toContain("Call ID")
    expect(html).toContain("Arguments")
    expect(html).toContain("JSON text")
    expect(html).toContain("{&quot;partial&quot;:")
    expect(html).toContain("Recorded error")
    expect(html).toContain("Recorded result · not an error")
    expect(html).toContain("Result not recorded")
    expect(html).toContain("No content blocks recorded.")
  })

  it("renders normal text without a nested panel or pre and retains tool output pre", () => {
    const html = render({
      truncated: false,
      messages: [
        { role: "user", content: [{ type: "text", text: "First line\nSecond line" }] },
        { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
      ],
    })
    expect(html).toContain('<p class="durable-message-text">First line\nSecond line</p>')
    expect(html).toContain('<pre class="durable-tool-output">tool output</pre>')
    expect(html).not.toContain("panel")
    expect(html).not.toContain("Message content is available.")
  })

  it("keeps tool arguments and results collapsed in the history reader", () => {
    const html = renderToStaticMarkup(
      createElement(EntryContent, {
        collapseTools: true,
        content: {
          truncated: false,
          messages: [
            {
              role: "assistant",
              content: [
                { type: "text", text: "Checking the result." },
                { type: "toolCall", id: "call", name: "lookup", arguments: "{}" },
              ],
            },
            { role: "toolResult", content: [{ type: "text", text: "Saved output" }] },
          ],
        },
      }),
    )
    expect(html).toContain(
      '<details aria-label="Tool call" class="durable-tool-call"><summary>lookup · Arguments</summary>',
    )
    expect(html).toContain("<details><summary>Tool output</summary>")
    expect(html).toContain("Checking the result.")
    expect(html).toContain("Saved output")
    expect(html).not.toContain("<details open")
  })

  it("shows empty content and truncation independently", () => {
    expect(render({ messages: [], truncated: false })).toContain("No message content recorded.")
    expect(render({ messages: [], truncated: false })).not.toContain("Content truncated")
    const html = render({ messages: [], truncated: true })
    expect(html).toContain('role="status"')
    expect(html).toContain("Content truncated")
    expect(html).toContain("No message content included in this response.")
    expect(html).not.toContain("No message content recorded.")
    const message = render({ messages: [{ role: "user", content: [] }], truncated: true })
    expect(message).toContain("No content blocks included in this response.")
    expect(message).not.toContain("No content blocks recorded.")
  })
})
