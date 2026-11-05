import { describe, expect, it, vi } from "vitest"

import {
  createProgressStatusEditor,
  renderActivityStatus,
  renderProgressStatus,
} from "../src/telegram/progress.js"

describe("Telegram progress status", () => {
  it("renders a native heading and task list, checking only completed steps", () => {
    expect(
      renderProgressStatus([
        { text: "分析需求", status: "completed" },
        { text: "修改程式", status: "in_progress" },
        { text: "執行測試", status: "pending" },
        { text: "發布 — 等待核准", status: "blocked" },
      ]),
    ).toBe(
      [
        "### 進度 1/4",
        "",
        "- [x] 分析需求",
        "- [ ] 🔄 修改程式",
        "- [ ] 執行測試",
        "- [ ] ⛔ 發布 — 等待核准",
      ].join("\n"),
    )
  })

  it("keeps activity in a native footer with a literal tool name", () => {
    expect(renderActivityStatus("tool", "bash")).toBe(
      "<footer>正在執行工具… · 工具：<code>bash</code></footer>",
    )
    expect(renderActivityStatus("tool_finished", "read\u202e\n")).toBe(
      "<footer>工具執行結束，等待模型回覆… · 工具：<code>read</code></footer>",
    )
    expect(renderActivityStatus("model")).toBe("<footer>正在等待模型回覆…</footer>")
    expect(renderActivityStatus("tool")).toBe("<footer>正在執行工具…</footer>")
    expect(renderActivityStatus("tool", " \u202e\n")).toBe("<footer>正在執行工具…</footer>")
  })

  it("escapes tool names without allowing HTML or Markdown injection into the footer", () => {
    expect(renderActivityStatus("tool", "</code></footer>& `**bash**`")).toBe(
      "<footer>正在執行工具… · 工具：<code>&lt;/code&gt;&lt;/footer&gt;&amp; `**bash**`</code></footer>",
    )
  })

  it("preserves links and literal code inside separate checklist items", () => {
    expect(
      renderProgressStatus([
        { text: "參考 [文件](https://example.test/path)", status: "completed" },
        { text: "檢查 `*literal*`", status: "in_progress" },
      ]),
    ).toBe(
      "### 進度 1/2\n\n- [x] 參考 [文件](https://example.test/path)\n- [ ] 🔄 檢查 `*literal*`",
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
      { text: "發布\u202e\n操作 — 等待\u200f 核准", status: "blocked" },
    ])

    expect(text).toBe(
      [
        "### 進度 8/11",
        "",
        ...Array.from({ length: 8 }, (_, index) => `- [x] 完成 ${index}`),
        "- [ ] 🔄 目前工作",
        "- [ ] 等待工作",
        "- [ ] ⛔ 發布操作 — 等待 核准",
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

  it("does not replace a queued snapshot with next-turn activity", async () => {
    vi.useFakeTimers()
    try {
      let finishFirst: (() => void) | undefined
      const first = new Promise<void>((resolve) => {
        finishFirst = resolve
      })
      const update = vi.fn(async (text: string) => {
        if (text === "tool") await first
      })
      const editor = createProgressStatusEditor(update, vi.fn())
      editor.publishActivity("tool")
      editor.publish("snapshot", true)
      editor.publishActivity("model")
      finishFirst?.()
      await editor.flush()
      expect(update.mock.calls.map(([text]) => text)).toEqual(["tool", "snapshot"])
      await vi.advanceTimersByTimeAsync(2_000)
      expect(update.mock.calls.map(([text]) => text)).toEqual(["tool", "snapshot", "model"])
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
    const update = vi.fn(async (text: string, _isProgress: boolean) => {
      if (text === "first") await first
    })
    const editor = createProgressStatusEditor(update, vi.fn())

    editor.publish("first", true)
    editor.publish("intermediate", true)
    editor.publish("latest", true)
    const flushing = editor.flush()
    finishFirst?.()
    await flushing
    await editor.close()

    expect(update.mock.calls).toEqual([
      ["first", true],
      ["latest", true],
    ])
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
