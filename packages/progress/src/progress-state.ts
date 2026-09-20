import { StringEnum } from "@earendil-works/pi-ai"
import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

export const PROGRESS_TOOL_NAME = "update_progress"
export const PROGRESS_DETAILS_VERSION = 1
export const PROGRESS_CONTEXT_MESSAGE_TYPE = "sumire-progress-status"
export const PROGRESS_CONTEXT_VERSION = 1
export const MAX_PROGRESS_STEPS = 50
export const MAX_PROGRESS_TEXT_LENGTH = 300
export const MAX_PROGRESS_REASON_LENGTH = 200

const progressStatuses = ["pending", "in_progress", "completed", "blocked"] as const
const resubmitGuidance = "Fix the input and resubmit the complete steps array."

export type ProgressStatus = (typeof progressStatuses)[number]

export interface ProgressStep {
  text: string
  status: ProgressStatus
  reason?: string
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
            maxLength: MAX_PROGRESS_TEXT_LENGTH,
            description: "A concise, action-oriented step",
          }),
          status: StringEnum(progressStatuses, {
            description: "The step's current status",
          }),
          reason: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: MAX_PROGRESS_REASON_LENGTH,
              description: "Required only for blocked steps; explain what must unblock the step",
            }),
          ),
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
    if (!hasOnlyKeys(entry, ["text", "status", "reason"])) {
      rejectProgress(`item ${item} contains an unsupported field.`)
    }
    if (typeof entry.text !== "string") rejectProgress(`item ${item} text must be a string.`)
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
    if (status === "blocked") {
      if (typeof entry.reason !== "string" || entry.reason.trim().length === 0) {
        rejectProgress(`item ${item} is blocked and requires a non-whitespace reason.`)
      }
      if (!hasMaxGraphemeLength(entry.reason, MAX_PROGRESS_REASON_LENGTH)) {
        rejectProgress(`item ${item} reason exceeds ${MAX_PROGRESS_REASON_LENGTH} characters.`)
      }
      steps.push({ text: entry.text, status, reason: entry.reason })
      continue
    }
    if (Object.hasOwn(entry, "reason")) {
      rejectProgress(`item ${item} may include reason only when status is blocked.`)
    }
    steps.push({ text: entry.text, status })
  }

  if (inProgressCount > 1) rejectProgress("keep at most one in_progress item.")
  return { steps }
}

export function parseProgressDetails(value: unknown): ProgressDetails | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "steps"]) ||
    value.version !== PROGRESS_DETAILS_VERSION
  ) {
    return undefined
  }
  try {
    return {
      version: PROGRESS_DETAILS_VERSION,
      steps: validateProgressArguments({ steps: value.steps }).steps,
    }
  } catch {
    return undefined
  }
}

export function cloneProgressSteps(steps: readonly ProgressStep[]): ProgressStep[] {
  return steps.map((step) => ({
    text: step.text,
    status: step.status,
    ...(step.reason === undefined ? {} : { reason: step.reason }),
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
      (step, index) =>
        step.text === right[index]?.text &&
        step.status === right[index]?.status &&
        step.reason === right[index]?.reason,
    )
  )
}

function rejectProgress(message: string): never {
  throw new Error(`Progress update rejected: ${message} ${resubmitGuidance}`)
}

function hasMaxGraphemeLength(value: string, maximum: number): boolean {
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
