import type { ProgressStep } from "@narumitw/sumire-progress"

const maxVisibleSteps = 6
const bidiControls = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu

export interface ProgressStatusEditor {
  publish(text: string): void
  close(): Promise<void>
}

export function renderProgressStatus(steps: readonly ProgressStep[]): string | undefined {
  if (steps.length === 0) return undefined

  const completed = steps.filter((step) => step.status === "completed").length
  const visible = selectVisibleSteps(steps)
  const lines = [`進度 ${completed}/${steps.length}`, "", ...visible.map(renderStep)]
  const hidden = steps.length - visible.length
  if (hidden > 0) lines.push(`…還有 ${hidden} 個步驟`)
  return lines.join("\n")
}

export function createProgressStatusEditor(
  update: (text: string) => Promise<void>,
  onError: (error: unknown) => void,
): ProgressStatusEditor {
  let closed = false
  let pending: string | undefined
  let lastPublished: string | undefined
  let active: Promise<void> | undefined

  const drain = async () => {
    while (!closed && pending !== undefined) {
      const text = pending
      pending = undefined
      if (text === lastPublished) continue
      try {
        await update(text)
        lastPublished = text
      } catch (error) {
        onError(error)
      }
    }
  }

  const start = () => {
    if (closed || active || pending === undefined) return
    active = drain().finally(() => {
      active = undefined
      start()
    })
  }

  return {
    publish(text) {
      if (closed || text === pending || text === lastPublished) return
      pending = text
      start()
    },
    async close() {
      closed = true
      pending = undefined
      while (active) await active
    },
  }
}

function selectVisibleSteps(steps: readonly ProgressStep[]): ProgressStep[] {
  if (steps.length <= maxVisibleSteps) return [...steps]

  const ranked = steps
    .map((step, index) => ({ step, index, rank: statusRank(step.status) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .slice(0, maxVisibleSteps)
    .sort((left, right) => left.index - right.index)
  return ranked.map(({ step }) => step)
}

function statusRank(status: ProgressStep["status"]): number {
  switch (status) {
    case "in_progress":
      return 0
    case "blocked":
      return 1
    case "pending":
      return 2
    case "completed":
      return 3
  }
}

function renderStep(step: ProgressStep): string {
  const text = sanitizeLine(step.text)
  switch (step.status) {
    case "completed":
      return `✅ ${text}`
    case "in_progress":
      return `🔄 ${text}`
    case "blocked":
      return `⛔ ${text} — ${sanitizeLine(step.reason ?? "等待外部條件")}`
    case "pending":
      return `⬜ ${text}`
  }
}

function sanitizeLine(value: string): string {
  return Array.from(value.replace(bidiControls, ""))
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint >= 0x20 && codePoint !== 0x7f
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim()
}
