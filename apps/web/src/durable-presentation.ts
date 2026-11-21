import type { DurableInspectionItem, DurableTaskItem } from "@narumitw/sumire-contracts"
import {
  ChatBubbleIcon,
  CodeIcon,
  FileTextIcon,
  GearIcon,
  LayersIcon,
  MagicWandIcon,
  PersonIcon,
} from "@radix-ui/react-icons"
import { getLocale, t } from "./i18n.js"

export function recordTypeLabel(type: DurableInspectionItem["type"]): string {
  const keys = {
    conversation: "record.conversation",
    task: "record.task",
    document: "record.document",
    entry: "record.entry",
  } as const
  const label = t(keys[type])
  return getLocale() === "en" ? label.toLowerCase() : label
}

export function recordRoleLabel(
  role: NonNullable<Extract<DurableInspectionItem, { type: "entry" }>["role"]>,
): string {
  const keys = {
    system: "record.system",
    user: "record.user",
    assistant: "record.assistant",
    toolResult: "record.toolResult",
  } as const
  return t(keys[role])
}

export function recordStatusLabel(
  status: DurableTaskItem["status"] | NonNullable<DurableTaskItem["outcome"]>,
): string {
  const keys = {
    completed: "record.completed",
    failed: "record.failed",
    aborted: "record.aborted",
    orphaned: "record.orphaned",
    faulted: "record.faulted",
    pending: "record.pending",
    running: "record.running",
    sleeping: "record.sleeping",
    waiting: "record.waiting",
    completing: "record.completing",
    terminal: "record.terminal",
  } as const
  return t(keys[status])
}

export function recordTone(item: DurableInspectionItem): string {
  if (item.type === "entry") return item.role === "toolResult" ? "result" : (item.role ?? "neutral")
  if (item.type === "task") {
    if (item.kind === "pi.tool") return "call"
    if (item.kind === "pi.generation") return "assistant"
  }
  return "neutral"
}

export function recordIcon(item: DurableInspectionItem) {
  if (item.type === "conversation") return ChatBubbleIcon
  if (item.type === "document") return FileTextIcon
  const tone = recordTone(item)
  if (tone === "user") return PersonIcon
  if (tone === "assistant") return MagicWandIcon
  if (tone === "system") return GearIcon
  if (tone === "call") return CodeIcon
  if (tone === "result") return LayersIcon
  return ChatBubbleIcon
}

export function recordBadge(item: DurableInspectionItem): string | undefined {
  if (item.type === "task")
    return item.outcome === undefined
      ? t("record.recordedStatus", { status: recordStatusLabel(item.status) })
      : t("record.recordedOutcome", { outcome: recordStatusLabel(item.outcome) })
  if (item.type === "entry" && item.isError !== undefined)
    return item.isError ? t("record.recordedError") : t("record.recordedResult")
  return undefined
}

export function recordTitle(item: DurableInspectionItem): string {
  switch (item.type) {
    case "conversation":
      return t("record.conversation")
    case "task":
      switch (item.kind) {
        case "pi.generation":
          return t("record.modelResponse")
        case "pi.tool":
          return t("record.toolCall")
        case "pi.compaction":
          return t("record.compaction")
        default:
          return t("record.task")
      }
    case "document":
      switch (item.kind) {
        case "pi.agent":
          return t("record.modelSettings")
        case "pi.usage":
          return t("record.modelUsage")
        case "sumire.session":
          return t("record.sessionSelection")
        default:
          return t("record.document")
      }
    case "entry":
      switch (item.role) {
        case "assistant":
          return t("record.assistantMessage")
        case "user":
          return t("record.userMessage")
        case "system":
          return t("record.systemMessage")
        case "toolResult":
          return item.toolName
            ? t("record.toolResultNamed", { name: item.toolName })
            : t("record.toolResult")
        default:
          return t("record.entry")
      }
  }
}

export function taskObservation(item: DurableTaskItem): string {
  if (item.outcome !== undefined) {
    return t("record.recordedOutcome", { outcome: recordStatusLabel(item.outcome) })
  }
  return t("record.statusWithoutOutcome", { status: recordStatusLabel(item.status) })
}

export function recordSummary(item: DurableInspectionItem): string {
  switch (item.type) {
    case "conversation":
      return item.parent
        ? t("record.branchedFrom", {
            conversation: item.parent.conversationId,
            entry: item.parent.at,
          })
        : t("record.noParentRelationship")
    case "task":
      return taskObservation(item)
    case "entry": {
      const content = !item.content
        ? t("record.entryMetadataOnly")
        : item.content.truncated
          ? t("record.messageTruncated")
          : item.content.messages.length === 0
            ? t("record.noMessages")
            : t("record.messageAvailable")
      return item.isError === undefined
        ? content
        : t("record.resultSummary", {
            result: item.isError ? t("record.toolError") : t("record.toolSuccess"),
            content,
          })
    }
    case "document":
      switch (item.valueState) {
        case "metadata-only":
          return t("record.documentMetadataOnly")
        case "available":
          return t("record.fieldsAvailable")
        case "unavailable":
          return t("record.valueUnavailable")
        case "withheld":
          switch (item.withheldReason) {
            case "unknown-kind":
              return t("record.unknownDocument")
            case "invalid-value":
              return t("record.invalidDocument")
            case "limit":
              return t("record.limitedDocument")
            default:
              return t("record.withheldDocument")
          }
      }
  }
}

export function recordMetadata(item: DurableInspectionItem): unknown {
  if (item.type === "document") {
    const { value: _value, ...metadata } = item
    return metadata
  }
  if (item.type === "entry") {
    const { content: _content, ...metadata } = item
    return metadata
  }
  return item
}

function utcTime(date: Date): string {
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC")
}

// Durable task times are wall-clock milliseconds, not document commit sequence numbers.
export function formatDurableTime(value: number | undefined): string {
  if (value === undefined || !Number.isSafeInteger(value) || value < 0)
    return t("record.notRecorded")
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? t("record.notRecorded") : utcTime(date)
}

export function formatReadTime(value: string): string {
  // Accept structured ISO timestamps only; Date.parse alone also accepts natural-language dates.
  const match =
    /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    )
  if (!match) return t("record.readTimeUnavailable")
  const calendarDate = new Date(`${match[1]}T00:00:00Z`)
  const date = new Date(value)
  if (
    Number.isNaN(calendarDate.getTime()) ||
    calendarDate.toISOString().slice(0, 10) !== match[1] ||
    Number.isNaN(date.getTime())
  )
    return t("record.readTimeUnavailable")
  return utcTime(date)
}
