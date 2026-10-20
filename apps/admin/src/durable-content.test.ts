import type { DurableEntryItem } from "@narumitw/sumire-contracts"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { EntryContent } from "./durable-inspector.js"

const untrusted = '<img src="https://untrusted.invalid/image" onerror="alert(1)">'
const render = (content: NonNullable<DurableEntryItem["content"]>) =>
  renderToStaticMarkup(createElement(EntryContent, { content }))

describe("Durable entry content", () => {
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
    expect(html).toContain("Arguments (JSON text)")
    expect(html).toContain("{&quot;partial&quot;:")
    expect(html).toContain("Error")
    expect(html).toContain("Not an error")
    expect(html).toContain("Not recorded")
    expect(html).toContain("No content blocks recorded.")
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
