import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import type { AgentEvent } from "@earendil-works/pi-durable"
import type { Logger } from "../../logging.js"

/** Translate durable events for the bot's session listeners. Harness owns retries and compaction. */
export function forwardDurableEvent(
  event: AgentEvent,
  emit: (event: AgentSessionEvent) => void,
  logger: Logger,
  sessionId: string,
): void {
  if (event.type === "run_start") emit({ type: "agent_start" })
  else if (event.type === "turn_start") emit({ type: "turn_start" })
  else if (event.type === "tool_execution_start") emit(event)
  else if (event.type === "tool_execution_end") {
    const result =
      event.result ?? event.entry?.model?.find((message) => message.role === "toolResult")
    emit({
      type: "tool_execution_end",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
      result,
      isError: !result || result.isError === true,
    })
  } else if (event.type === "auto_retry_start") {
    logger.info(`Durable retry session_id=${sessionId} attempt=${event.attempt}`)
  } else if (event.type === "compaction_start" || event.type === "compaction_end") {
    logger.info(
      `Durable ${event.type} session_id=${sessionId} task_id=${event.taskId} reason=${event.reason}`,
    )
  } else if (event.type === "message_end") {
    const message = event.entry.model?.[0]
    if (message) emit({ type: "message_end", message })
  }
}
