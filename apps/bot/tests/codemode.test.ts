import {
  createCodemodeExtension,
  type ExtensionAPI,
  type ExtensionFactory,
  type ToolDefinition,
  type ToolLoadout,
} from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createBotCodemodeExtension } from "../src/agent/codemode.js"

async function registeredTool(factory: ExtensionFactory): Promise<ToolDefinition> {
  let tool: ToolDefinition | undefined
  await factory({
    getSettings: () => ({}),
    registerTool: (definition: ToolDefinition) => {
      tool = definition
    },
  } as ExtensionAPI)
  if (!tool) throw new Error("codemode was not registered")
  return tool
}

const execute = (tool: ToolDefinition, code: string, signal?: AbortSignal) =>
  tool.execute("script", { code }, signal, undefined, undefined as never)

const resultText = (result: Awaited<ReturnType<typeof execute>>) =>
  result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")

afterEach(() => vi.restoreAllMocks())

describe("Bot codemode policy", () => {
  it("preserves every native field except execute, without starting timers during registration", async () => {
    const native = await registeredTool(createCodemodeExtension({ mode: "on", models: false }))
    const timers = vi.spyOn(globalThis, "setTimeout")
    const bounded = await registeredTool(createBotCodemodeExtension(300_000))
    expect(timers).not.toHaveBeenCalled()
    const { execute: _nativeExecute, prepareLoadout: nativeLoadout, ...nativeMetadata } = native
    const { execute: _boundedExecute, prepareLoadout: boundedLoadout, ...boundedMetadata } = bounded
    expect(boundedMetadata).toEqual(nativeMetadata)
    const emptyLoadout: ToolLoadout = {
      declared: [],
      callable: [],
      registered: [],
      getExposure: () => "direct",
      getNamespace: () => undefined,
    }
    expect(boundedLoadout?.(emptyLoadout)).toEqual(nativeLoadout?.(emptyLoadout))
    expect(bounded.defaultActive).toBe(false)
    expect(bounded.exposure).toBe("model-only")
    expect(bounded.prepareLoadout).toBeTypeOf("function")
    expect(bounded.constrainedSampling).toMatchObject({ type: "grammar" })
  })

  it("enforces the host deadline even when the script requests a longer limit", async () => {
    const tool = await registeredTool(createBotCodemodeExtension(150))
    const timers = vi.spyOn(globalThis, "setTimeout")
    const cleared = vi.spyOn(globalThis, "clearTimeout")
    const result = await execute(
      tool,
      '// @options: {"timeout_ms": 60000}\ntext("partial"); while (true) {}',
    )
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain("150ms host deadline")
    expect(cleared).toHaveBeenCalledWith(timers.mock.results[0]?.value)
    expect(resultText(await execute(tool, 'return "next script"'))).toContain("next script")
  })

  it("honors a shorter script deadline and does not expose models or host APIs", async () => {
    const tool = await registeredTool(createBotCodemodeExtension(5_000))
    const result = await execute(tool, '// @options: {"timeout_ms": 100}\nwhile (true) {}')
    expect(result.isError).toBe(true)
    expect(resultText(result)).not.toContain("host deadline")
    expect(
      resultText(
        await execute(
          tool,
          "return [typeof models, typeof process, typeof fetch, typeof setTimeout]",
        ),
      ),
    ).toContain('["undefined","undefined","undefined","undefined"]')
  })

  it("rejects pre-aborted execution without creating a deadline timer", async () => {
    const tool = await registeredTool(createBotCodemodeExtension(300_000))
    const timers = vi.spyOn(globalThis, "setTimeout")
    const controller = new AbortController()
    controller.abort(new Error("caller cancelled"))
    await expect(execute(tool, "return 1", controller.signal)).rejects.toThrow("caller cancelled")
    expect(timers).not.toHaveBeenCalled()
  })

  it("propagates in-flight caller cancellation and clears its own deadline", async () => {
    const tool = await registeredTool(createBotCodemodeExtension(5_000))
    const controller = new AbortController()
    const cancellation = setTimeout(() => controller.abort(new Error("caller cancelled")), 100)
    const timers = vi.spyOn(globalThis, "setTimeout")
    const cleared = vi.spyOn(globalThis, "clearTimeout")
    try {
      const result = await execute(tool, "while (true) {}", controller.signal)
      expect(result.isError).toBe(true)
      expect(resultText(result)).not.toContain("host deadline")
      expect(cleared).toHaveBeenCalledWith(timers.mock.results[0]?.value)
    } finally {
      clearTimeout(cancellation)
    }
  })

  it.each([
    ["successful execution", "return 1", false],
    ["syntax failure", "const =", true],
  ] as const)("clears the deadline on %s", async (_scenario, code, isError) => {
    const tool = await registeredTool(createBotCodemodeExtension(300_000))
    const timers = vi.spyOn(globalThis, "setTimeout")
    const cleared = vi.spyOn(globalThis, "clearTimeout")
    const result = await execute(tool, code)
    expect(Boolean(result.isError)).toBe(isError)
    expect(timers.mock.results[0]?.value.hasRef()).toBe(false)
    expect(cleared).toHaveBeenCalledWith(timers.mock.results[0]?.value)
  })
})
