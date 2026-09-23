import { describe, expect, it, vi } from "vitest"

import { parsePiProgressDetails } from "../src/agent/pi-progress.js"
import { createProgressStatusEditor, renderProgressStatus } from "../src/telegram/progress.js"

describe("Telegram progress status", () => {
  it("accepts only valid pi-progress version 4 tool details", () => {
    const steps = [{ text: "分析需求", status: "in_progress" }]
    expect(parsePiProgressDetails({ version: 4, steps })).toEqual(steps)
    expect(parsePiProgressDetails({ version: 4, steps: [] })).toEqual([])
    expect(parsePiProgressDetails({ version: 1, steps })).toBeUndefined()
    expect(
      parsePiProgressDetails({ version: 4, steps: [{ text: "", status: "pending" }] }),
    ).toBeUndefined()
    expect(
      parsePiProgressDetails({ version: 4, steps: [{ text: "等待", status: "blocked" }] }),
    ).toBeUndefined()
    expect(parsePiProgressDetails({ version: 4, steps: "invalid" })).toBeUndefined()
  })

  it("renders completed, active, pending, and blocked steps", () => {
    expect(
      renderProgressStatus([
        { text: "分析需求", status: "completed" },
        { text: "修改程式", status: "in_progress" },
        { text: "執行測試", status: "pending" },
        { text: "發布", status: "blocked", reason: "等待核准" },
      ]),
    ).toBe(
      ["進度 1/4", "", "✅ 分析需求", "🔄 修改程式", "⬜ 執行測試", "⛔ 發布 — 等待核准"].join(
        "\n",
      ),
    )
  })

  it("renders the progress clear operation", () => {
    expect(renderProgressStatus([])).toBe("進度已清除")
  })

  it("prioritizes actionable work and bounds long lists", () => {
    const text = renderProgressStatus([
      ...Array.from({ length: 8 }, (_, index) => ({
        text: `完成 ${index}`,
        status: "completed" as const,
      })),
      { text: "目前工作", status: "in_progress" },
      { text: "等待工作", status: "pending" },
    ])

    expect(text).toContain("🔄 目前工作")
    expect(text).toContain("⬜ 等待工作")
    expect(text).toContain("…還有 4 個步驟")
    expect(text.split("\n")).toHaveLength(9)
  })

  it("coalesces updates and waits for an active edit before closing", async () => {
    let finishFirst: (() => void) | undefined
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve
    })
    const update = vi.fn(async (text: string) => {
      if (text === "first") await first
    })
    const onError = vi.fn()
    const editor = createProgressStatusEditor(update, onError)

    editor.publish("first")
    editor.publish("second")
    editor.publish("latest")
    const closing = editor.close()
    await Promise.resolve()
    expect(update).toHaveBeenCalledTimes(1)

    finishFirst?.()
    await closing
    expect(update).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })
})
