import type { DurableInspectionItem, DurableTaskItem } from "@narumitw/sumire-contracts"

export function recordTitle(item: DurableInspectionItem): string {
  switch (item.type) {
    case "conversation":
      return item.active
        ? "Selected conversation"
        : item.parent
          ? "Conversation branch"
          : "Historical conversation"
    case "task":
      switch (item.kind) {
        case "pi.generation":
          return "Model response"
        case "pi.tool":
          return "Tool call"
        case "pi.compaction":
          return "Context compaction"
        default:
          return "Task"
      }
    case "document":
      switch (item.kind) {
        case "pi.agent":
          return "Model settings"
        case "pi.usage":
          return "Model usage"
        case "sumire.session":
          return "Session selection"
        default:
          return "Document"
      }
    case "entry":
      switch (item.role) {
        case "assistant":
          return "Assistant message record"
        case "user":
          return "User message record"
        case "system":
          return "System message record"
        case "toolResult":
          return item.toolName ? `Tool result: ${item.toolName}` : "Tool result record"
        default:
          return "Entry record"
      }
  }
}

export function taskObservation(item: DurableTaskItem): string {
  if (item.outcome !== undefined) {
    const outcomes = {
      completed: "Completed",
      failed: "Failed",
      aborted: "Aborted",
      orphaned: "Orphaned",
      faulted: "Faulted",
    }
    return `Recorded outcome: ${outcomes[item.outcome]}`
  }
  const statuses = {
    pending: "Pending",
    running: "Running",
    waiting: "Waiting",
    completing: "Completing",
    terminal: "Terminal",
  }
  return `Recorded status: ${statuses[item.status]} · no outcome recorded`
}

export function recordSummary(item: DurableInspectionItem): string {
  switch (item.type) {
    case "conversation":
      return item.parent
        ? `Branched from conversation ${item.parent.conversationId} at entry ${item.parent.at}.`
        : "No parent relationship recorded."
    case "task":
      return taskObservation(item)
    case "entry": {
      const content = !item.content
        ? "Only metadata is included. Inspect this entry to read message content."
        : item.content.truncated
          ? "Message content is truncated."
          : item.content.messages.length === 0
            ? "No message content recorded."
            : "Message content is available."
      return item.isError === undefined
        ? content
        : `${item.isError ? "Recorded tool error." : "Recorded tool result (not an error)."} ${content}`
    }
    case "document":
      switch (item.valueState) {
        case "metadata-only":
          return "Only metadata is included. Inspect this document to read approved fields."
        case "available":
          return "Approved document fields are available."
        case "unavailable":
          return "The document value is unavailable."
        case "withheld":
          switch (item.withheldReason) {
            case "unknown-kind":
              return "This document is not approved for value inspection."
            case "invalid-value":
              return "The document value is withheld because it does not match the approved format."
            case "limit":
              return "The document value is withheld because it exceeds inspection limits."
            default:
              return "The document value is withheld. No reason is recorded."
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
  if (value === undefined || !Number.isSafeInteger(value) || value < 0) return "Not recorded"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "Not recorded" : utcTime(date)
}

export function formatReadTime(value: string): string {
  // Accept structured ISO timestamps only; Date.parse alone also accepts natural-language dates.
  const match =
    /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    )
  if (!match) return "Read time unavailable"
  const calendarDate = new Date(`${match[1]}T00:00:00Z`)
  const date = new Date(value)
  if (
    Number.isNaN(calendarDate.getTime()) ||
    calendarDate.toISOString().slice(0, 10) !== match[1] ||
    Number.isNaN(date.getTime())
  )
    return "Read time unavailable"
  return utcTime(date)
}
