import type { Tool } from "@earendil-works/pi-mcp"
import { describe, expect, it } from "vitest"
import { mcpPresentationSchema } from "../src/agent/mcp-metadata.js"

const redact = (text: string) => text.replaceAll("fixture-secret", "[redacted]")

describe("MCP schema presentation", () => {
  it("redacts annotations and omits credential defaults without changing validation semantics", () => {
    const schema: Tool["inputSchema"] = {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["one", "two"],
          description: "fixture-secret",
          default: "fixture-secret",
        },
        nested: { type: "array", items: { type: "string", examples: ["fixture-secret"] } },
      },
      required: ["mode"],
    }
    const original = JSON.stringify(schema)
    expect(mcpPresentationSchema(schema, redact)).toEqual({
      type: "object",
      properties: {
        mode: { type: "string", enum: ["one", "two"], description: "[redacted]" },
        nested: { type: "array", items: { type: "string" } },
      },
      required: ["mode"],
    })
    expect(JSON.stringify(schema)).toBe(original)
  })
  it.each([
    { properties: { "fixture-secret": { type: "string" } } },
    { properties: { value: { enum: ["fixture-secret"] } } },
    { properties: { value: { const: { description: "fixture-secret" } } } },
    { required: ["fixture-secret"] },
    { $ref: "#/$defs/fixture-secret" },
  ])(
    "withholds credential-bearing structural data rather than corrupting or exposing it",
    (fields) => {
      const schema = { type: "object" as const, ...fields }
      const original = JSON.stringify(schema)
      expect(mcpPresentationSchema(schema, redact)).toBeUndefined()
      expect(JSON.stringify(schema)).toBe(original)
    },
  )
})
