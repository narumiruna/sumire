import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import type { ToolExecutionApi } from "@earendil-works/pi-durable"
import { describe, expect, it, vi } from "vitest"

import { createProgressExtension } from "../src/agent/durable-progress.js"

describe("durable progress replay", () => {
  it("migrates saved legacy execution arguments but rejects new legacy calls", async () => {
    const authorize = vi.fn()
    const tool = createProgressExtension(authorize).tools?.[0]
    if (!tool?.prepareArguments) throw new Error("Missing progress tool")
    const savedArguments = {
      steps: [{ text: "Deploy", status: "blocked", reason: "Waiting for approval" }],
    }
    const prepare = tool.prepareArguments
    expect(() => prepare(savedArguments)).toThrow(/unsupported field/iu)
    const state = { steps: [] }
    const doc = vi.fn(async () => state)
    const api = {
      conversationId: 1,
      commit: async (change: (tx: { doc: typeof doc }) => Promise<void>) => change({ doc }),
    } as unknown as ToolExecutionApi
    // ToolTask recovery bypasses prepareArguments and calls execute with its saved intent.
    const result = await tool.execute(savedArguments, api, context)
    expect(authorize).toHaveBeenCalledOnce()
    expect(result.details).toEqual({
      version: 2,
      steps: [{ text: "Deploy — Waiting for approval", status: "blocked" }],
    })
    expect(state.steps).toEqual([{ text: "Deploy — Waiting for approval", status: "blocked" }])
    expect(savedArguments.steps[0]?.reason).toBe("Waiting for approval")
    await expect(
      tool.execute(
        {
          steps: [{ text: "Deploy", status: "blocked", reason: " " }],
        },
        api,
        context,
      ),
    ).rejects.toThrow(/unsupported field/iu)
  })
})
