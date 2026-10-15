import { StringEnum } from "@earendil-works/pi-ai"
import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent"
import { type TUnsafe, Type } from "typebox"

export const PROGRESS_TOOL_NAME = "update_progress"
export const PROGRESS_DETAILS_VERSION = 2
export const PROGRESS_CONTEXT_MESSAGE_TYPE = "sumire-progress-status"
export const PROGRESS_CONTEXT_VERSION = 1
export const MAX_PROGRESS_STEPS = 50
// Accommodate the previous text, separator, and blocked reason without data loss.
export const MAX_PROGRESS_TEXT_LENGTH = 503
export const MAX_PROGRESS_TEXT_CODE_POINTS = 8_192

const progressStatuses = ["pending", "in_progress", "completed", "blocked"] as const
const resubmitGuidance = "Fix the input and resubmit the complete steps array."

export type ProgressStatus = (typeof progressStatuses)[number]

const progressStatusSchema: TUnsafe<ProgressStatus> = StringEnum(progressStatuses, {
  description: "The step's current status",
})

export interface ProgressStep {
  text: string
  status: ProgressStatus
}

export interface ProgressDetails {
  version: typeof PROGRESS_DETAILS_VERSION
  steps: ProgressStep[]
}

export const ProgressParameters = Type.Object(
  {
    steps: Type.Array(
      Type.Object(
        {
          text: Type.String({
            minLength: 1,
            maxLength: MAX_PROGRESS_TEXT_CODE_POINTS,
            description: "A concise, action-oriented step (at most 503 grapheme clusters)",
          }),
          status: progressStatusSchema,
        },
        { additionalProperties: false },
      ),
      {
        maxItems: MAX_PROGRESS_STEPS,
        description: "The complete current progress state; send an empty array to clear it",
      },
    ),
  },
  { additionalProperties: false },
)

export function validateProgressArguments(value: unknown): { steps: ProgressStep[] } {
  if (!isRecord(value) || !hasOnlyKeys(value, ["steps"]) || !Object.hasOwn(value, "steps")) {
    rejectProgress("input must be an object containing only a steps array.")
  }
  if (!Array.isArray(value.steps)) rejectProgress("steps must be an array.")
  if (value.steps.length > MAX_PROGRESS_STEPS) {
    rejectProgress(
      `steps contains ${value.steps.length} items; the maximum is ${MAX_PROGRESS_STEPS}.`,
    )
  }

  const steps: ProgressStep[] = []
  let inProgressCount = 0
  for (const [index, entry] of value.steps.entries()) {
    const item = index + 1
    if (!isRecord(entry)) rejectProgress(`item ${item} must be an object.`)
    if (!hasOnlyKeys(entry, ["text", "status"])) {
      rejectProgress(`item ${item} contains an unsupported field.`)
    }
    if (typeof entry.text !== "string") rejectProgress(`item ${item} text must be a string.`)
    if (!hasMaxCodePointLength(entry.text, MAX_PROGRESS_TEXT_CODE_POINTS)) {
      rejectProgress(`item ${item} text exceeds ${MAX_PROGRESS_TEXT_CODE_POINTS} code points.`)
    }
    if (entry.text.trim().length === 0) {
      rejectProgress(`item ${item} text must contain non-whitespace text.`)
    }
    if (!hasMaxGraphemeLength(entry.text, MAX_PROGRESS_TEXT_LENGTH)) {
      rejectProgress(`item ${item} text exceeds ${MAX_PROGRESS_TEXT_LENGTH} characters.`)
    }
    if (!progressStatuses.includes(entry.status as ProgressStatus)) {
      rejectProgress(`item ${item} status must be pending, in_progress, completed, or blocked.`)
    }

    const status = entry.status as ProgressStatus
    if (status === "in_progress") inProgressCount += 1
    steps.push({ text: entry.text, status })
  }

  if (inProgressCount > 1) rejectProgress("keep at most one in_progress item.")
  return { steps }
}

export function parseProgressDetails(value: unknown): ProgressDetails | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "steps"]) ||
    (value.version !== 1 && value.version !== PROGRESS_DETAILS_VERSION)
  ) {
    return undefined
  }
  try {
    return {
      version: PROGRESS_DETAILS_VERSION,
      steps: validateProgressArguments({
        steps: value.version === 1 ? migrateLegacySteps(value.steps) : value.steps,
      }).steps,
    }
  } catch {
    return undefined
  }
}

function migrateLegacySteps(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return value.map((step) => {
    if (!isRecord(step) || !hasOnlyKeys(step, ["text", "status", "reason"])) {
      rejectProgress("invalid legacy step.")
    }
    if (
      typeof step.text !== "string" ||
      !step.text.trim() ||
      !hasMaxGraphemeLength(step.text, 300)
    ) {
      rejectProgress("invalid legacy text.")
    }
    if (step.status !== "blocked") {
      if (Object.hasOwn(step, "reason")) rejectProgress("invalid legacy reason.")
      return step
    }
    if (
      typeof step.reason !== "string" ||
      !step.reason.trim() ||
      !hasMaxGraphemeLength(step.reason, 200)
    ) {
      rejectProgress("invalid legacy blocked reason.")
    }
    return { text: `${step.text} — ${step.reason}`, status: step.status }
  })
}

export function cloneProgressSteps(steps: readonly ProgressStep[]): ProgressStep[] {
  return steps.map((step) => ({
    text: step.text,
    status: step.status,
  }))
}

export function reconstructProgress(entries: readonly SessionEntry[]): ProgressStep[] {
  let restored: ProgressStep[] = []
  for (const entry of entries) {
    if (entry.type !== "message") continue
    const message = entry.message
    if (
      message.role !== "toolResult" ||
      message.toolName !== PROGRESS_TOOL_NAME ||
      message.isError
    ) {
      continue
    }
    const details = parseProgressDetails(message.details)
    if (details) restored = details.steps
  }
  return restored
}

export function reconcileProgressContext(
  messages: ContextEvent["messages"],
  steps: readonly ProgressStep[],
): ContextEvent["messages"] {
  const withoutOwned = messages.filter(
    (message) => message.role !== "custom" || message.customType !== PROGRESS_CONTEXT_MESSAGE_TYPE,
  )
  if (steps.length === 0 || hasVisibleProgressState(withoutOwned, steps)) {
    return withoutOwned.length === messages.length ? messages : withoutOwned
  }

  const boundary = leadingSummaryBoundary(withoutOwned)
  const contextMessage: ContextEvent["messages"][number] = {
    role: "custom",
    customType: PROGRESS_CONTEXT_MESSAGE_TYPE,
    content: progressContextContent(steps),
    display: false,
    details: { version: PROGRESS_CONTEXT_VERSION },
    timestamp: 0,
  }
  return [...withoutOwned.slice(0, boundary), contextMessage, ...withoutOwned.slice(boundary)]
}

function hasVisibleProgressState(
  messages: ContextEvent["messages"],
  steps: readonly ProgressStep[],
): boolean {
  let latest: ProgressStep[] | undefined
  for (const message of messages) {
    if (
      message.role !== "toolResult" ||
      message.toolName !== PROGRESS_TOOL_NAME ||
      message.isError
    ) {
      continue
    }
    const details = parseProgressDetails(message.details)
    if (details) latest = details.steps
  }
  return latest !== undefined && progressStepsEqual(latest, steps)
}

function progressContextContent(steps: readonly ProgressStep[]): string {
  return `[SUMIRE PROGRESS STATUS v${PROGRESS_CONTEXT_VERSION}]\nCurrent progress steps as JSON data:\n${JSON.stringify({ steps: cloneProgressSteps(steps) })}`
}

function leadingSummaryBoundary(messages: ContextEvent["messages"]): number {
  let index = messages[0]?.role === "system" ? 1 : 0
  while (index < messages.length) {
    const role = messages[index]?.role
    if (role !== "compactionSummary" && role !== "branchSummary") break
    index += 1
  }
  return index
}

function progressStepsEqual(
  left: readonly ProgressStep[],
  right: readonly ProgressStep[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (step, index) => step.text === right[index]?.text && step.status === right[index]?.status,
    )
  )
}

function rejectProgress(message: string): never {
  throw new Error(`Progress update rejected: ${message} ${resubmitGuidance}`)
}

function hasMaxCodePointLength(value: string, maximum: number): boolean {
  let count = 0
  for (const _character of value) {
    count += 1
    if (count > maximum) return false
  }
  return true
}

function hasMaxGraphemeLength(value: string, maximum: number): boolean {
  if (!hasMaxCodePointLength(value, MAX_PROGRESS_TEXT_CODE_POINTS)) return false
  let count = 0
  for (const _character of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
    value,
  )) {
    count += 1
    if (count > maximum) return false
  }
  return true
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
