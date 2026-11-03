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
import type { Logger } from "../../logging.js"

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
): void {
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
    if (slot.status === "running") {
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
      emit({
        type: "tool_execution_end",
        ...identity,
        result,
        isError: result?.isError ?? ("summary" in slot ? (slot.summary?.isError ?? true) : true),
      })
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
    logger.info(`Durable retry session_id=${sessionId} attempt=${live.generation?.attempt}`)
  }
  for (const status of live.compactions ?? []) {
    if (!before.compactions?.some((prior) => prior.taskId === status.taskId)) {
      logger.info(
        `Durable compaction_start session_id=${sessionId} task_id=${status.taskId} trigger=${status.trigger}`,
      )
    }
  }
  for (const status of before.compactions ?? []) {
    if (!live.compactions?.some((next) => next.taskId === status.taskId)) {
      logger.info(
        `Durable compaction_end session_id=${sessionId} task_id=${status.taskId} trigger=${status.trigger}`,
      )
    }
  }
}
