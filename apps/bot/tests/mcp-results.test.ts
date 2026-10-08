import os from "node:os"
import type { CallToolResult, ContentBlock } from "@earendil-works/pi-mcp"
import { describe, expect, it } from "vitest"
import { shapeMcpResult } from "../src/agent/mcp-results.js"

const data = "aGVsbG8="
describe("MCP result protocol redaction", () => {
  it.each(["text", "content", "isError", "meta", "type", "mimeType", "resource"])(
    "preserves envelope semantics when the credential is %s",
    async (secret) => {
      const raw: CallToolResult = {
        content: [
          { type: "text", text: `${secret} payload`, _meta: { private: "private-metadata" } },
          { type: "image", data, mimeType: "image/png", _meta: { private: "private-metadata" } },
          { type: "audio", data, mimeType: "audio/wav" },
          {
            type: "resource",
            resource: {
              uri: "https://example.com/item",
              text: `${secret} payload`,
              _meta: { private: "private-metadata" },
            },
          },
          { type: "resource_link", uri: "https://example.com/item", name: `${secret} payload` },
        ],
        structuredContent: { payload: secret },
        isError: true,
        _meta: { private: "private-metadata" },
      }
      const original = JSON.stringify(raw)
      const result = await shapeMcpResult(raw, os.tmpdir(), (text) =>
        text.replaceAll(secret, "[redacted]"),
      )
      const envelope = result.structuredContent as unknown as CallToolResult
      expect(result.isError).toBe(true)
      expect(envelope.isError).toBe(true)
      expect(envelope.content.map((block) => block.type)).toEqual(
        raw.content.map((block) => block.type),
      )
      expect(envelope.content[0]).toEqual({ type: "text", text: "[redacted] payload" })
      expect(result.content[0]).toEqual({ type: "text", text: "[redacted] payload" })
      expect(envelope.content[1]).toEqual({ type: "image", data, mimeType: "image/png" })
      expect(envelope.structuredContent).toEqual({ payload: "[redacted]" })
      expect(JSON.stringify(result)).not.toContain("private-metadata")
      for (const block of envelope.content) {
        expect(block).not.toHaveProperty("_meta")
        if (block.type === "resource") expect(block.resource).not.toHaveProperty("_meta")
      }
      expect(JSON.stringify(raw)).toBe(original)
    },
  )
  it.each([
    { content: [{ type: "text", text: "okay", annotations: { audience: ["fixture-secret"] } }] },
    { content: [{ type: "text", text: "okay", annotations: { priority: "fixture-secret" } }] },
    {
      content: [
        {
          type: "resource_link",
          uri: "https://example.com/item",
          name: "item",
          size: "fixture-secret",
        },
      ],
    },
    { content: [], isError: "fixture-secret" },
  ])("rejects malformed protocol metadata instead of leaking unchecked values", async (raw) => {
    await expect(
      shapeMcpResult(raw as unknown as CallToolResult, os.tmpdir(), (text) =>
        text.replaceAll("fixture-secret", "[redacted]"),
      ),
    ).rejects.toThrow("Invalid MCP")
  })
  it("rejects credential-bearing MIME metadata instead of rewriting it", async () => {
    await expect(
      shapeMcpResult(
        { content: [{ type: "image", data, mimeType: "fixture-secret" }] },
        os.tmpdir(),
        (text) => text.replaceAll("fixture-secret", "[redacted]"),
      ),
    ).rejects.toThrow("contains configured credentials")
  })
  it.each([false, undefined])("preserves false or absent error flags: %s", async (isError) => {
    const result = await shapeMcpResult(
      { content: [], ...(isError === undefined ? {} : { isError }) },
      os.tmpdir(),
      (text) => text.replaceAll("isError", "[redacted]"),
    )
    expect(result.isError).toBe(false)
    expect((result.structuredContent as unknown as CallToolResult).isError).toBe(isError)
  })

  it.each(["image", "audio", "resource"] as const)(
    "rejects credential-bearing %s bytes without rewriting binary data",
    async (type) => {
      const block: ContentBlock =
        type === "resource"
          ? { type, resource: { uri: "https://example.com/item", blob: data } }
          : { type, data, mimeType: type === "image" ? "image/png" : "audio/wav" }
      const raw = { content: [block] }
      const original = JSON.stringify(raw)
      await expect(
        shapeMcpResult(raw, os.tmpdir(), (text) => text.replaceAll(data, "[redacted]")),
      ).rejects.toThrow("contains configured credentials")
      expect(JSON.stringify(raw)).toBe(original)
    },
  )
})
