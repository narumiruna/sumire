import type { ToolCall } from "@earendil-works/pi-ai"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import {
  type CommitPublication,
  type ConversationId,
  type ConversationView,
  type EntryId,
  type EntryRecord,
  type LiveState,
  NestedCallDoc,
  type NestedCallState,
  type NestedToolExecutionResult,
  type TaskId,
} from "@earendil-works/pi-durable"
import type { Logger, SpanAttributes } from "../../logging.js"

/** Native control reasons only. Never export settlement detail or diagnostic text. */
export function durableReason(reason: string) {
  switch (reason) {
    case "model_error":
    case "no_model":
    case "aborted":
    case "reset":
    case "faulted":
    case "orphaned":
    case "interrupted":
    case "restart_limit":
    case "nothing_to_answer":
    case "turn_limit":
    case "run_failed":
    case "withdrawn":
    case "missing_task":
    case "task_too_old":
    case "migration_failed":
    case "stale":
      return reason
    default:
      return "unknown"
  }
}

/** Project on the commit line; write logs later, outside the native observer. */
export function durableCommitEvents(
  publication: CommitPublication,
  conversationId: ConversationId,
  sessionId: string,
  chatId?: number,
): Array<{ message: string; attributes: SpanAttributes }> {
  const events: Array<{ message: string; attributes: SpanAttributes }> = []
  const correlation: SpanAttributes = {
    "pi.session_id": sessionId,
    "pi.conversation_id": conversationId,
    ...(chatId === undefined ? {} : { "telegram.chat_id": chatId }),
  }
  for (const change of publication.changes) {
    if (change.type === "submission" && change.value.conversationId === conversationId) {
      const record = change.value
      if (record.status !== "done" && record.status !== "unanswered") continue
      events.push({
        message: "Durable submission settled",
        attributes: {
          ...correlation,
          "event.name": "pi.submission.settled",
          "pi.submission_id": record.id,
          ...(record.requestId ? { "pi.request_id": record.requestId } : {}),
          "pi.submission_type": record.type,
          "pi.settled_status": record.status,
          ...("answer" in record && record.answer !== undefined
            ? { "pi.entry_id": record.answer }
            : {}),
          ...(record.status === "unanswered" ? { "pi.reason": durableReason(record.reason) } : {}),
        },
      })
    } else if (
      change.type === "task" &&
      change.value.conversationId === conversationId &&
      change.value.kind === "pi.compaction" &&
      change.value.state.status === "terminal"
    ) {
      events.push({
        message: "Durable compaction settled",
        attributes: {
          ...correlation,
          "event.name": "pi.compaction.end",
          "pi.task_id": change.value.id,
          "pi.outcome": change.value.state.outcome.status,
        },
      })
    }
  }
  return events
}

/** Capture nested payloads at their commit, before the parent retires its result documents. */
export function recordNestedResults(
  publication: CommitPublication,
  conversationId: ConversationId,
  results: Map<TaskId, NestedToolExecutionResult>,
): void {
  for (const change of publication.changes) {
    if (
      change.type !== "document" ||
      change.kind !== "change" ||
      change.record.kind !== NestedCallDoc.definition.kind ||
      change.conversationId !== conversationId
    ) {
      continue
    }
    const state = change.value as NestedCallState
    if (state.taskId !== undefined && state.result !== undefined) {
      results.set(state.taskId, state.result)
    }
  }
}

/** Keep appended entries that can leave the bounded view before listeners receive it. */
export function recordMessageEntries(
  publication: CommitPublication,
  conversationId: ConversationId,
  entries: Map<EntryId, EntryRecord>,
): void {
  for (const change of publication.changes) {
    if (change.type === "entry" && change.value.conversationId === conversationId) {
      entries.set(change.value.id, change.value)
    }
  }
}

/** Translate consecutive observed views. The attachment snapshot is the baseline, not an event. */
export function forwardDurableView(
  previous: ConversationView,
  current: ConversationView,
  emit: (event: AgentSessionEvent) => void,
  logger: Logger,
  sessionId: string,
  nestedResults: Map<TaskId, NestedToolExecutionResult>,
  committedEntries: Map<EntryId, EntryRecord>,
  chatId?: number,
): void {
  const correlation: SpanAttributes = {
    "pi.session_id": sessionId,
    "pi.conversation_id": current.conversation.id,
    ...(chatId === undefined ? {} : { "telegram.chat_id": chatId }),
  }
  const before: LiveState = previous.docs["pi.live"] ?? {}
  const live: LiveState = current.docs["pi.live"] ?? {}
  const taskChanged = before.run?.taskId !== live.run?.taskId
  if (!before.run && live.run) emit({ type: "agent_start" })
  if (live.run && taskChanged) emit({ type: "turn_start" })

  // Recover this revision's entries from the commit, including those outside its window.
  const newest = previous.entries.at(-1)?.id ?? previous.before ?? 0
  const through = current.entries.at(-1)?.id ?? current.before ?? 0
  const appended = new Map(
    current.entries.filter((entry) => entry.id > newest).map((entry) => [entry.id, entry]),
  )
  for (const [id, entry] of committedEntries) {
    if (id > through) continue // A later commit can arrive before this notification runs.
    committedEntries.delete(id)
    if (id > newest) appended.set(id, entry)
  }
  for (const entry of [...appended.values()].sort((a, b) => a.id - b.id)) {
    const message = entry.model?.[0]
    if (message) emit({ type: "message_end", message })
    if (message?.role === "assistant") {
      const log =
        message.stopReason === "error" ? logger.error.bind(logger) : logger.info.bind(logger)
      log("Pi model response", {
        ...correlation,
        "event.name": "pi.model.response",
        "pi.entry_id": entry.id,
        ...(entry.byTaskId === undefined ? {} : { "pi.task_id": entry.byTaskId }),
        "pi.model": message.model,
        "pi.provider": message.provider,
        "pi.stop_reason": message.stopReason,
        "pi.outcome":
          message.stopReason === "error"
            ? "failed"
            : message.stopReason === "aborted"
              ? "cancelled"
              : "completed",
        "pi.input_tokens": message.usage.input,
        "pi.output_tokens": message.usage.output,
        "pi.cache_read_tokens": message.usage.cacheRead,
        "pi.cache_write_tokens": message.usage.cacheWrite,
        "pi.total_tokens": message.usage.totalTokens,
      })
    }
  }

  const assistant = current.entries
    .findLast((entry) => entry.model?.some((message) => message.role === "assistant"))
    ?.model?.findLast((message) => message.role === "assistant")
  const previousSlots = new Map(
    [...(before.tools ?? []), ...(before.nestedTools ?? [])].map((slot) => [
      slot.taskId ?? slot.callId,
      slot,
    ]),
  )
  for (const slot of [...(live.tools ?? []), ...(live.nestedTools ?? [])]) {
    const prior =
      slot.taskId === undefined && taskChanged
        ? undefined
        : previousSlots.get(slot.taskId ?? slot.callId)
    if (prior?.status === slot.status) continue
    const identity = {
      toolCallId: slot.callId,
      toolName: slot.name,
      ...("parentCallId" in slot ? { parentToolCallId: slot.parentCallId } : {}),
    }
    const toolAttributes = {
      ...correlation,
      "pi.tool_name": slot.name,
      "pi.tool_call_id": slot.callId,
      ...(slot.taskId === undefined ? {} : { "pi.task_id": slot.taskId }),
      ...("parentCallId" in slot
        ? { "pi.parent_tool_call_id": slot.parentCallId, "pi.parent_task_id": slot.parentTaskId }
        : live.run
          ? { "pi.parent_task_id": live.run.taskId }
          : {}),
    }
    if (slot.status === "running") {
      logger.info("Pi tool started", { ...toolAttributes, "event.name": "pi.tool.start" })
      const args =
        "arguments" in slot
          ? slot.arguments
          : (assistant?.content.find(
              (part): part is ToolCall => part.type === "toolCall" && part.id === slot.callId,
            )?.arguments ?? {})
      emit({ type: "tool_execution_start", ...identity, args })
    } else if (slot.status === "done") {
      const result =
        "parentTaskId" in slot
          ? nestedResults.get(slot.taskId)
          : (
              current.entries.find((entry) => entry.id === slot.entry) ??
              (slot.entry === undefined ? undefined : appended.get(slot.entry))
            )?.model?.find((message) => message.role === "toolResult")
      const isError =
        result?.isError ?? ("summary" in slot ? (slot.summary?.isError ?? true) : true)
      logger.info("Pi tool finished", {
        ...toolAttributes,
        "event.name": "pi.tool.end",
        "pi.success": !isError,
        ...("summary" in slot && slot.summary?.durationMs !== undefined
          ? { "pi.duration_ms": slot.summary.durationMs }
          : {}),
      })
      emit({ type: "tool_execution_end", ...identity, result, isError })
      if ("parentTaskId" in slot) nestedResults.delete(slot.taskId)
    }
  }
  const nestedTasks = new Set(live.nestedTools?.map((slot) => slot.taskId))
  for (const slot of before.nestedTools ?? []) {
    if (!nestedTasks.has(slot.taskId)) nestedResults.delete(slot.taskId)
  }

  const retry = live.generation?.retry
  if (
    retry &&
    (taskChanged ||
      before.generation?.attempt !== live.generation?.attempt ||
      before.generation?.retry?.at !== retry.at ||
      before.generation?.retry?.error !== retry.error)
  ) {
    logger.info("Durable retry", {
      ...correlation,
      "event.name": "pi.retry",
      ...(live.run ? { "pi.task_id": live.run.taskId } : {}),
      "pi.attempt": live.generation?.attempt ?? 0,
    })
  }
  for (const status of live.compactions ?? []) {
    if (!before.compactions?.some((prior) => prior.taskId === status.taskId)) {
      logger.info("Durable compaction started", {
        ...correlation,
        "event.name": "pi.compaction.start",
        "pi.task_id": status.taskId,
        "pi.trigger": status.trigger,
        "pi.blocking": status.blocking,
        "pi.attempt": status.attempt,
      })
    }
  }
  if (
    live.runFailure &&
    live.runFailure !== before.runFailure &&
    (live.runFailure.taskId !== before.runFailure?.taskId ||
      live.runFailure.reason !== before.runFailure?.reason)
  ) {
    const log =
      live.runFailure.reason === "aborted" || live.runFailure.reason === "reset"
        ? logger.info.bind(logger)
        : logger.error.bind(logger)
    log("Durable run ended without answer", {
      ...correlation,
      "event.name": "pi.run.unanswered",
      "pi.task_id": live.runFailure.taskId,
      "pi.reason": durableReason(live.runFailure.reason),
      "pi.settled_status": "unanswered",
    })
  }
  if (
    live.compactionFailure &&
    live.compactionFailure.taskId !== before.compactionFailure?.taskId
  ) {
    logger.warn("Durable compaction failed", {
      ...correlation,
      "event.name": "pi.compaction.failed",
      "pi.task_id": live.compactionFailure.taskId,
      "pi.trigger": live.compactionFailure.trigger,
      "pi.outcome": "failed",
    })
  }
}
