import type { ToolCall } from "@earendil-works/pi-ai"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import type { ConversationView, LiveState } from "@earendil-works/pi-durable"
import type { Logger } from "../../logging.js"

/** Translate consecutive observed views. The attachment snapshot is the baseline, not an event. */
export function forwardDurableView(
  previous: ConversationView,
  current: ConversationView,
  emit: (event: AgentSessionEvent) => void,
  logger: Logger,
  sessionId: string,
): void {
  const before: LiveState = previous.docs["pi.live"] ?? {}
  const live: LiveState = current.docs["pi.live"] ?? {}
  const taskChanged = before.run?.taskId !== live.run?.taskId
  if (!before.run && live.run) emit({ type: "agent_start" })
  if (live.run && taskChanged) emit({ type: "turn_start" })

  // IDs ascend even when the bounded window drops the previous newest entry.
  const newest = previous.entries.at(-1)?.id ?? previous.before ?? 0
  for (const entry of current.entries) {
    const message = entry.model?.[0]
    if (entry.id > newest && message) emit({ type: "message_end", message })
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
        "entry" in slot
          ? current.entries
              .find((entry) => entry.id === slot.entry)
              ?.model?.find((message) => message.role === "toolResult")
          : undefined
      emit({
        type: "tool_execution_end",
        ...identity,
        result,
        isError: "summary" in slot ? (slot.summary?.isError ?? true) : (result?.isError ?? true),
      })
    }
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
