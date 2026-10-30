import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import { entryContent } from "../src/admin/durable-entry-content.js"

const assistant: AssistantMessage = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "Check the file.", thinkingSignature: "PRIVATE_SIGNATURE" },
    { type: "text", text: "Reading the file.", textSignature: "PRIVATE_SIGNATURE" },
    {
      type: "toolCall",
      id: "call-1",
      name: "read",
      arguments: { path: "README.md" },
      thoughtSignature: "PRIVATE_SIGNATURE",
    },
  ],
  api: "openai-completions",
  provider: "fixture",
  model: "fixture",
  usage: {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "toolUse",
  timestamp: 1,
}
const result: ToolResultMessage = {
  role: "toolResult",
  toolName: "read",
  toolCallId: "call-1",
  isError: false,
  timestamp: 2,
  content: [
    { type: "text", text: '<script>alert("untrusted")</script>' },
    { type: "image", mimeType: "image/png", data: "PRIVATE_IMAGE_BYTES" },
  ],
  details: { credential: "PRIVATE_DETAILS" },
}

describe("entry content projection", () => {
  it("returns text, thinking, arguments, tool identity and result status without protocol data", () => {
    const content = entryContent([assistant, result])
    expect(content).toEqual({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Check the file." },
            { type: "text", text: "Reading the file." },
            { type: "toolCall", id: "call-1", name: "read", arguments: '{"path":"README.md"}' },
          ],
        },
        {
          role: "toolResult",
          toolName: "read",
          toolCallId: "call-1",
          isError: false,
          content: [
            { type: "text", text: '<script>alert("untrusted")</script>' },
            { type: "image", mimeType: "image/png" },
          ],
        },
      ],
      truncated: false,
    })
    expect(JSON.stringify(content)).not.toContain("PRIVATE_")
  })

  it("preserves result errors and normalizes string message content", () => {
    expect(entryContent([{ ...result, isError: true }]).messages[0]?.isError).toBe(true)
    expect(entryContent([{ role: "user", content: "Hello", timestamp: 1 }])).toEqual({
      messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
      truncated: false,
    })
    expect(entryContent(undefined)).toEqual({ messages: [], truncated: false })
  })

  it("bounds long UTF-8 text and arguments and marks incomplete content", () => {
    const content = entryContent([
      { role: "user", content: "漢🙂".repeat(10000), timestamp: 1 },
      {
        ...assistant,
        content: [
          { type: "toolCall", id: "1", name: "read", arguments: { value: "x".repeat(100000) } },
        ],
      },
    ])
    expect(content.truncated).toBe(true)
    const block = content.messages[0]?.content[0]
    expect(block?.type).toBe("text")
    if (block?.type !== "text") throw new Error("Expected text")
    expect(Buffer.byteLength(block.text)).toBeLessThanOrEqual(16 * 1024)
    expect(block.text).not.toContain("�")
    expect(JSON.stringify(content)).not.toContain("x".repeat(20000))
  })

  it("bounds the serialized content, including JSON escapes and many blocks", () => {
    for (const text of ["x".repeat(16000), "\u0000".repeat(16000), "a"]) {
      const content = entryContent([
        {
          ...result,
          content: Array.from({ length: 1000 }, () => ({ type: "text" as const, text })),
        },
      ])
      expect(content.truncated).toBe(true)
      expect(Buffer.byteLength(JSON.stringify(content))).toBeLessThanOrEqual(128 * 1024)
      expect(content.messages[0]?.content.length).toBeLessThanOrEqual(256)
    }
  })

  it("keeps bounded content as an ordered prefix when the next block does not fit", () => {
    const prefix = Array.from({ length: 7 }, (_, index) => ({
      type: "text" as const,
      text: `${index}:`.padEnd(16 * 1024, "x"),
    }))
    const content = entryContent([
      {
        ...result,
        content: [
          ...prefix,
          { type: "text", text: "\u0000".repeat(16 * 1024) },
          { type: "text", text: "OMITTED_LATER_BLOCK" },
        ],
      },
      { role: "user", content: "OMITTED_LATER_MESSAGE", timestamp: 3 },
    ])
    expect(content.truncated).toBe(true)
    expect(content.messages).toHaveLength(1)
    expect(content.messages[0]?.content).toEqual(prefix)
    expect(JSON.stringify(content)).not.toContain("OMITTED_")
    expect(Buffer.byteLength(JSON.stringify(content))).toBeLessThanOrEqual(128 * 1024)
  })

  it("marks tool identity and serialized arguments prefixes without repairing incomplete JSON", () => {
    const argumentsValue = { text: "漢🙂".repeat(10000) }
    const identity = "漢🙂".repeat(1000)
    const content = entryContent([
      {
        ...assistant,
        content: [{ type: "toolCall", id: identity, name: identity, arguments: argumentsValue }],
      },
      { ...result, toolName: identity, toolCallId: identity, content: [] },
    ])
    expect(content.truncated).toBe(true)
    const block = content.messages[0]?.content[0]
    if (block?.type !== "toolCall") throw new Error("Missing tool call")
    for (const value of [
      block.id,
      block.name,
      content.messages[1]?.toolName ?? "",
      content.messages[1]?.toolCallId ?? "",
    ]) {
      expect(Buffer.byteLength(value)).toBeLessThanOrEqual(1024)
      expect(value.length).toBeGreaterThan(0)
      expect(identity.startsWith(value)).toBe(true)
      expect(value).not.toContain("�")
    }
    expect(Buffer.byteLength(block.arguments)).toBeLessThanOrEqual(16 * 1024)
    expect(JSON.stringify(argumentsValue).startsWith(block.arguments)).toBe(true)
    expect(block.arguments).not.toContain("�")
    expect(() => JSON.parse(block.arguments)).toThrow()
  })

  it("bounds repeated message headers and rejects malformed scalar content", () => {
    const content = entryContent(Array.from({ length: 1000 }, () => ({ ...result, content: [] })))
    expect(content.truncated).toBe(true)
    expect(content.messages.length).toBeLessThanOrEqual(256)
    expect(() =>
      entryContent([
        { ...result, toolName: { nested: "private" } } as unknown as ToolResultMessage,
      ]),
    ).toThrow()
  })
})
