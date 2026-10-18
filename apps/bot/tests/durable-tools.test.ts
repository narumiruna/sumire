import { describe, expect, it } from "vitest"
import {
  durableToolResult,
  isCodemodeCallable,
  type NativeTool,
} from "../src/agent/durable-tools.js"

describe("durable tool results", () => {
  it.each([false, true])("preserves model output and failure status %s", (isError) => {
    const content = [
      { type: "text" as const, text: "Tool output" },
      { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" },
    ]
    const result = durableToolResult({ content, details: { value: 42 }, isError })
    expect(result).toEqual({ output: content, details: { value: 42 }, isError })
    expect(result).not.toHaveProperty("content")
  })

  it("removes undefined fields and maps early termination", () => {
    expect(durableToolResult({ content: [], details: undefined, terminate: true })).toEqual({
      output: [],
      control: { terminate: true },
    })
  })
})

describe("codemode tool access", () => {
  it.each([
    [undefined, true],
    ["direct", true],
    ["deferred", true],
    ["model-only", false],
    ["hidden", false],
  ] as const)("exposure %s has callable status %s", (exposure, callable) => {
    const tool: Pick<NativeTool, "exposure"> = { exposure }
    expect(isCodemodeCallable(tool)).toBe(callable)
  })
})
