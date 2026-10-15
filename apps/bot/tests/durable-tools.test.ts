import { describe, expect, it } from "vitest"
import { isCodemodeCallable, type NativeTool } from "../src/agent/durable-tools.js"

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
