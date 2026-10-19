import type { Message } from "@earendil-works/pi-ai"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import type {
  AgentEvent,
  ConversationId,
  EntryId,
  EntryRecord,
  TaskId,
} from "@earendil-works/pi-durable"
import { describe, expect, it, vi } from "vitest"
import { forwardDurableEvent } from "../src/agent/durable/events.js"

function setup() {
  const emit = vi.fn<(event: AgentSessionEvent) => void>()
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return {
    emit,
    logger,
    forward: (event: AgentEvent) => forwardDurableEvent(event, emit, logger, "session"),
  }
}

function entry(model: Message[] = []): EntryRecord {
  return { id: 2 as EntryId, conversationId: 1 as ConversationId, kind: "message", model }
}

const toolResult: Message = {
  role: "toolResult",
  toolCallId: "call",
  toolName: "read",
  content: [{ type: "text", text: "result" }],
  isError: false,
  timestamp: 0,
}

describe("durable event translation", () => {
  it("translates run and turn starts and forwards tool starts unchanged", () => {
    const { emit, forward } = setup()
    const start: AgentEvent = {
      type: "tool_execution_start",
      toolCallId: "call",
      toolName: "read",
      args: {},
    }
    forward({ type: "run_start", inputs: [] })
    forward({ type: "turn_start" })
    forward(start)
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: "agent_start" },
      { type: "turn_start" },
      start,
    ])
  })

  it("uses a committed tool result when a direct call ends", () => {
    const { emit, forward } = setup()
    forward({
      type: "tool_execution_end",
      toolCallId: "call",
      toolName: "read",
      entry: entry([toolResult]),
    })
    expect(emit).toHaveBeenCalledWith({
      type: "tool_execution_end",
      toolCallId: "call",
      toolName: "read",
      result: toolResult,
      isError: false,
    })
  })

  it("prefers the nested result and preserves the parent call ID", () => {
    const { emit, forward } = setup()
    const result = {
      taskId: 3 as TaskId,
      diagnostics: [],
      content: [{ type: "text" as const, text: "nested failure" }],
      isError: true,
    }
    forward({
      type: "tool_execution_end",
      toolCallId: "nested",
      toolName: "read",
      parentToolCallId: "parent",
      result,
      entry: entry([toolResult]),
    })
    expect(emit).toHaveBeenCalledWith({
      type: "tool_execution_end",
      toolCallId: "nested",
      toolName: "read",
      parentToolCallId: "parent",
      result,
      isError: true,
    })
  })

  it("reports an error when a tool ends without a result", () => {
    const { emit, forward } = setup()
    forward({ type: "tool_execution_end", toolCallId: "call", toolName: "read" })
    expect(emit).toHaveBeenCalledWith({
      type: "tool_execution_end",
      toolCallId: "call",
      toolName: "read",
      result: undefined,
      isError: true,
    })
  })

  it("emits only the first model message and ignores entries without messages", () => {
    const { emit, forward } = setup()
    const message: Message = { role: "user", content: "first", timestamp: 0 }
    forward({ type: "message_end", entry: entry() })
    forward({ type: "message_end", entry: entry([message, toolResult]) })
    expect(emit).toHaveBeenCalledExactlyOnceWith({ type: "message_end", message })
  })

  it("logs retries and compaction without emitting session events", () => {
    const { emit, logger, forward } = setup()
    forward({ type: "auto_retry_start", attempt: 2, at: 0, errorMessage: "retry" })
    forward({ type: "compaction_start", taskId: 3 as TaskId, reason: "threshold", blocking: true })
    forward({ type: "compaction_end", taskId: 3 as TaskId, reason: "threshold" })
    forward({ type: "run_end", inputs: [] })
    expect(logger.info.mock.calls).toEqual([
      ["Durable retry session_id=session attempt=2"],
      ["Durable compaction_start session_id=session task_id=3 reason=threshold"],
      ["Durable compaction_end session_id=session task_id=3 reason=threshold"],
    ])
    expect(emit).not.toHaveBeenCalled()
  })
})
