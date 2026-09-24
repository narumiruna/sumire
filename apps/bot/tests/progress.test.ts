import { describe, expect, it, vi } from "vitest"

import { createProgressStatusEditor, renderProgressStatus } from "../src/telegram/progress.js"

describe("Telegram progress status", () => {
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

  it("renders every step in order, including completed steps beyond six", () => {
    const text = renderProgressStatus([
      ...Array.from({ length: 8 }, (_, index) => ({
        text: `完成 ${index}`,
        status: "completed" as const,
      })),
      { text: "目前工作", status: "in_progress" },
      { text: "等待工作", status: "pending" },
      { text: "發布\u202e\n操作", status: "blocked", reason: "等待\u200f 核准" },
    ])

    expect(text).toBe(
      [
        "進度 8/11",
        "",
        ...Array.from({ length: 8 }, (_, index) => `✅ 完成 ${index}`),
        "🔄 目前工作",
        "⬜ 等待工作",
        "⛔ 發布操作 — 等待 核准",
      ].join("\n"),
    )
  })

  it("rate-limits activity edits and retains the latest state", async () => {
    vi.useFakeTimers()
    try {
      const update = vi.fn(async (_text: string) => undefined)
      const editor = createProgressStatusEditor(update, vi.fn())

      editor.publishActivity("model")
      editor.publishActivity("tool")
      editor.publishActivity("tool_finished")
      expect(update.mock.calls.map(([text]) => text)).toEqual(["model"])

      await vi.advanceTimersByTimeAsync(1_999)
      expect(update).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(update.mock.calls.map(([text]) => text)).toEqual(["model", "tool_finished"])

      editor.publishActivity("tool")
      await editor.close()
      await vi.advanceTimersByTimeAsync(2_000)
      expect(update).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("publishes structured progress immediately and cancels stale activity", async () => {
    vi.useFakeTimers()
    try {
      const update = vi.fn(async (_text: string) => undefined)
      const editor = createProgressStatusEditor(update, vi.fn())

      editor.publishActivity("model")
      await Promise.resolve()
      editor.publishActivity("tool")
      editor.publish("進度 0/1")
      await Promise.resolve()
      expect(update.mock.calls.map(([text]) => text)).toEqual(["model", "進度 0/1"])

      await vi.advanceTimersByTimeAsync(2_000)
      expect(update).toHaveBeenCalledTimes(2)
      await editor.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it("restores the last structured status after an in-flight activity edit", async () => {
    let finishActivity: (() => void) | undefined
    const activity = new Promise<void>((resolve) => {
      finishActivity = resolve
    })
    const update = vi.fn(async (text: string) => {
      if (text === "tool") await activity
    })
    const editor = createProgressStatusEditor(update, vi.fn())

    editor.publish("進度 0/1")
    await new Promise<void>((resolve) => setImmediate(resolve))
    editor.publishActivity("tool")
    editor.publish("進度 0/1")
    expect(update.mock.calls.map(([text]) => text)).toEqual(["進度 0/1", "tool"])

    finishActivity?.()
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(3))
    expect(update.mock.calls[2]?.[0]).toBe("進度 0/1")
    await editor.close()
  })

  it("flushes the latest snapshot before keeping the status as history", async () => {
    let finishFirst: (() => void) | undefined
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve
    })
    const update = vi.fn(async (text: string) => {
      if (text === "first") await first
    })
    const editor = createProgressStatusEditor(update, vi.fn())

    editor.publish("first")
    editor.publish("intermediate")
    editor.publish("latest")
    const flushing = editor.flush()
    finishFirst?.()
    await flushing
    await editor.close()

    expect(update.mock.calls.map(([text]) => text)).toEqual(["first", "latest"])
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
