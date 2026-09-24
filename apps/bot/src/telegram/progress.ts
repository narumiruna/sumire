import type { ProgressStep } from "@narumitw/sumire-progress"

const activityEditIntervalMs = 2_000
const bidiControls = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu

export interface ProgressStatusEditor {
  publish(text: string): void
  publishActivity(text: string): void
  flush(): Promise<void>
  close(): Promise<void>
}

export function renderProgressStatus(steps: readonly ProgressStep[]): string {
  if (steps.length === 0) return "進度已清除"

  const completed = steps.filter((step) => step.status === "completed").length
  return [`進度 ${completed}/${steps.length}`, "", ...steps.map(renderStep)].join("\n")
}

export function createProgressStatusEditor(
  update: (text: string) => Promise<void>,
  onError: (error: unknown) => void,
): ProgressStatusEditor {
  let closed = false
  let pending: string | undefined
  let lastPublished: string | undefined
  let active: Promise<void> | undefined
  let nextActivityAt = 0
  let latestActivity: string | undefined
  let activityTimer: ReturnType<typeof setTimeout> | undefined

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

  const enqueue = (text: string) => {
    if (closed || text === pending || (!active && text === lastPublished)) return
    pending = text
    start()
  }

  const cancelActivity = () => {
    if (activityTimer !== undefined) clearTimeout(activityTimer)
    activityTimer = undefined
    latestActivity = undefined
  }

  const flushActivity = () => {
    activityTimer = undefined
    const text = latestActivity
    latestActivity = undefined
    if (closed || text === undefined) return
    nextActivityAt = Date.now() + activityEditIntervalMs
    enqueue(text)
  }

  return {
    publish(text) {
      cancelActivity()
      enqueue(text)
    },
    publishActivity(text) {
      if (closed) return
      latestActivity = text
      if (activityTimer !== undefined) return
      const delay = Math.max(0, nextActivityAt - Date.now())
      if (delay === 0) flushActivity()
      else activityTimer = setTimeout(flushActivity, delay)
    },
    async flush() {
      while (active) await active
    },
    async close() {
      closed = true
      cancelActivity()
      pending = undefined
      while (active) await active
    },
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
