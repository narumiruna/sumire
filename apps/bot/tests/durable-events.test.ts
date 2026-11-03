import type { AssistantMessage, Message } from "@earendil-works/pi-ai"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import type {
  CommitPublication,
  CompactionResult,
  ConversationId,
  ConversationView,
  DocumentId,
  EntryId,
  EntryRecord,
  LiveState,
  NestedToolExecutionResult,
  NestedToolSlot,
  Seq,
  TaskId,
  ToolSlot,
} from "@earendil-works/pi-durable"
import { NestedCallDoc } from "@earendil-works/pi-durable"
import { describe, expect, it, vi } from "vitest"
import {
  forwardDurableView,
  recordMessageEntries,
  recordNestedResults,
} from "../src/agent/durable/events.js"

function setup() {
  const emit = vi.fn<(event: AgentSessionEvent) => void>()
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const nestedResults = new Map<TaskId, NestedToolExecutionResult>()
  const messageEntries = new Map<EntryId, EntryRecord>()
  return {
    emit,
    logger,
    nestedResults,
    messageEntries,
    forward: (previous: ConversationView, current: ConversationView) =>
      forwardDurableView(previous, current, emit, logger, "session", nestedResults, messageEntries),
  }
}

function view(
  live: LiveState = {},
  entries: readonly EntryRecord[] = [],
  before?: number,
): ConversationView {
  return {
    conversation: { id: 1 as ConversationId },
    docs: { "pi.live": live },
    entries,
    ...(before === undefined ? {} : { before: before as EntryId }),
  }
}

function entry(id: number, model?: readonly Message[]): EntryRecord {
  return { id: id as EntryId, conversationId: 1 as ConversationId, kind: "message", model }
}

const run = { taskId: 10 as TaskId, inputs: [], turns: 0 }

function tool(overrides: Partial<ToolSlot> = {}): ToolSlot {
  return { taskId: 20 as TaskId, callId: "call", name: "read", status: "running", ...overrides }
}

function nested(overrides: Partial<NestedToolSlot> = {}): NestedToolSlot {
  return {
    taskId: 21 as TaskId,
    parentTaskId: 20 as TaskId,
    callId: "call/child",
    parentCallId: "call",
    name: "read",
    arguments: { path: "nested" },
    status: "running",
    ...overrides,
  }
}

function assistant(path = "current"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "call", name: "read", arguments: { path } }],
    api: "openai-responses",
    provider: "openai",
    model: "test",
    stopReason: "toolUse",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}

const toolResult: Message = {
  role: "toolResult",
  toolCallId: "call",
  toolName: "read",
  content: [{ type: "text", text: "result" }],
  details: { steps: [] },
  isError: false,
  timestamp: 0,
}

const toolEnd = {
  type: "tool_execution_end",
  toolCallId: "call",
  toolName: "read",
  result: undefined,
  isError: true,
}

const nestedEnd = {
  ...toolEnd,
  toolCallId: "call/child",
  parentToolCallId: "call",
}

describe("durable view translation", () => {
  it("recovers bulk entries in order without emitting a future commit early", () => {
    const { emit, forward, messageEntries } = setup()
    const previous = entry(1, [{ role: "user", content: "old", timestamp: 0 }])
    const appended = Array.from({ length: 120 }, (_, index) =>
      entry(index + 2, [{ role: "user", content: `message ${index}`, timestamp: index }]),
    )
    const future = entry(122, [{ role: "user", content: "future", timestamp: 122 }])
    const foreign = { ...future, id: 999 as EntryId, conversationId: 2 as ConversationId }
    recordMessageEntries(
      {
        seq: 1 as Seq,
        changes: [...appended, future, foreign]
          .reverse()
          .map((value) => ({ type: "entry" as const, value })),
      },
      1 as ConversationId,
      messageEntries,
    )
    expect(messageEntries.size).toBe(121)
    const current = view({}, appended.slice(-50), 71)
    forward(view({}, [previous]), current)
    expect(emit.mock.calls.map(([event]) => event)).toEqual(
      appended.map((record) => ({ type: "message_end", message: record.model?.[0] })),
    )
    expect([...messageEntries.keys()]).toEqual([future.id])
    const next = view({}, [...appended.slice(-49), future], 72)
    forward(current, next)
    forward(next, next)
    expect(emit).toHaveBeenCalledTimes(121)
    expect(emit).toHaveBeenLastCalledWith({ type: "message_end", message: future.model?.[0] })
    expect(messageEntries.size).toBe(0)
  })

  it("discards captured attachment history without replaying its messages", () => {
    const { emit, forward, messageEntries } = setup()
    const baseline = entry(1, [{ role: "user", content: "existing", timestamp: 0 }])
    recordMessageEntries(
      { seq: 1 as Seq, changes: [{ type: "entry", value: baseline }] },
      1 as ConversationId,
      messageEntries,
    )
    forward(view({}, [baseline]), view({ run }, [baseline]))
    expect(emit.mock.calls.map(([event]) => event.type)).toEqual(["agent_start", "turn_start"])
    expect(messageEntries.size).toBe(0)
  })

  it("starts an agent on a run and starts turns only when the generation task changes", () => {
    const { emit, forward } = setup()
    const first = view({ run })
    const next = view({ run: { ...run, taskId: 11 as TaskId, turns: 1 } })
    forward(view(), first)
    forward(first, view({ run, generation: { attempt: 2 } }))
    forward(first, next)
    forward(next, view({ runFailure: { taskId: 11 as TaskId, inputs: [], reason: "faulted" } }))
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "turn_start" },
    ])
  })

  it("uses the current assistant's original arguments when a direct slot starts", () => {
    const { emit, forward } = setup()
    const entries = [entry(1, [assistant("old")]), entry(2, [assistant()])]
    forward(
      view({ run, tools: [tool({ status: "pending", taskId: undefined })] }, entries),
      view({ run, tools: [tool()] }, entries),
    )
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      type: "tool_execution_start",
      toolCallId: "call",
      toolName: "read",
      args: { path: "current" },
    })
  })

  it("uses the committed direct result, including details, when a slot becomes done", () => {
    const { emit, forward } = setup()
    forward(
      view({ run, tools: [tool()] }),
      view({ run, tools: [tool({ status: "done", entry: 3 as EntryId })] }, [
        entry(3, [toolResult]),
      ]),
    )
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: "message_end", message: toolResult },
      { ...toolEnd, result: toolResult, isError: false },
    ])
  })

  it("ends a skipped pending call without emitting a tool start", () => {
    const { emit, forward } = setup()
    const result: Message = { ...toolResult, isError: true }
    forward(
      view({ run, tools: [tool({ status: "pending", unoffered: true })] }),
      view({ run, tools: [tool({ status: "done", entry: 3 as EntryId, unoffered: true })] }, [
        entry(3, [result]),
      ]),
    )
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { type: "message_end", message: result },
      { ...toolEnd, result },
    ])
  })

  it.each([undefined, 99 as EntryId])(
    "reports a direct fault or missing committed result as an error (entry %s)",
    (resultEntry) => {
      const { emit, forward } = setup()
      forward(
        view({ run, tools: [tool()] }),
        view({ run, tools: [tool({ status: "done", entry: resultEntry })] }),
      )
      expect(emit).toHaveBeenCalledExactlyOnceWith(toolEnd)
    },
  )

  it("starts nested calls with their own arguments and parent call IDs", () => {
    const { emit, forward } = setup()
    forward(
      view({ run, tools: [tool()], nestedTools: [nested({ status: "pending" })] }),
      view({ run, tools: [tool()], nestedTools: [nested()] }),
    )
    expect(emit).toHaveBeenCalledExactlyOnceWith({
      type: "tool_execution_start",
      toolCallId: "call/child",
      toolName: "read",
      parentToolCallId: "call",
      args: { path: "nested" },
    })
  })

  it.each([false, true])(
    "preserves the nested summary's isError=%s without a full result",
    (isError) => {
      const { emit, forward } = setup()
      forward(
        view({ run, tools: [tool()], nestedTools: [nested()] }),
        view({
          run,
          tools: [tool()],
          nestedTools: [nested({ status: "done", summary: { isError, error: "bounded summary" } })],
        }),
      )
      expect(emit).toHaveBeenCalledExactlyOnceWith({ ...nestedEnd, isError })
    },
  )

  it.each([false, true])("keeps the committed nested payload when isError=%s", (isError) => {
    const { emit, forward, nestedResults } = setup()
    const result: NestedToolExecutionResult = {
      taskId: nested().taskId,
      structuredOutput: [{ type: "text", text: "nested output" }],
      details: { value: "nested details" },
      diagnostics: [],
      durationMs: 7,
      isError,
    }
    nestedResults.set(result.taskId, result)
    const before = view({ run, nestedTools: [nested()] })
    const done = view({
      run,
      nestedTools: [nested({ status: "done", summary: { isError } })],
    })
    forward(before, done)
    forward(done, done)
    expect(emit).toHaveBeenCalledExactlyOnceWith({ ...nestedEnd, result, isError })
    expect(nestedResults.size).toBe(0)
  })

  it("keeps committed results after parent retirement and ignores other conversations", () => {
    const { emit, forward, nestedResults } = setup()
    const result = {
      taskId: nested().taskId,
      structuredOutput: "nested output",
      details: { value: "retained details" },
      diagnostics: [],
      isError: false,
    } satisfies NestedToolExecutionResult
    const record = {
      id: 40 as DocumentId,
      kind: NestedCallDoc.definition.kind,
      key: "child",
      scope: { kind: "task" as const, taskId: nested().parentTaskId },
      createdAt: 1 as Seq,
    }
    const publication: CommitPublication = {
      seq: 2 as Seq,
      changes: [
        {
          type: "document",
          kind: "change",
          record,
          conversationId: 1 as ConversationId,
          version: 1,
          value: { taskId: result.taskId, result },
          ops: [],
        },
      ],
    }
    recordNestedResults(publication, 2 as ConversationId, nestedResults)
    expect(nestedResults.size).toBe(0)
    recordNestedResults(publication, 1 as ConversationId, nestedResults)
    recordNestedResults(
      {
        seq: 3 as Seq,
        changes: [
          { type: "document", kind: "retire", record, conversationId: 1 as ConversationId },
        ],
      },
      1 as ConversationId,
      nestedResults,
    )
    forward(
      view({ run, nestedTools: [nested()] }),
      view({ run, nestedTools: [nested({ status: "done", summary: { isError: false } })] }),
    )
    expect(emit).toHaveBeenCalledExactlyOnceWith({ ...nestedEnd, result, isError: false })
    expect(nestedResults.size).toBe(0)
  })

  it("releases captured results when a restored done slot leaves the view", () => {
    const { emit, forward, nestedResults } = setup()
    nestedResults.set(nested().taskId, {
      taskId: nested().taskId,
      structuredOutput: "old result",
      diagnostics: [],
      isError: false,
    })
    forward(view({ run, nestedTools: [nested({ status: "done" })] }), view())
    expect(emit).not.toHaveBeenCalled()
    expect(nestedResults.size).toBe(0)
  })

  it("reports a nested fault without a summary as an error", () => {
    const { emit, forward } = setup()
    forward(
      view({ run, nestedTools: [nested()] }),
      view({ run, nestedTools: [nested({ status: "done" })] }),
    )
    expect(emit).toHaveBeenCalledExactlyOnceWith(nestedEnd)
  })

  it("does not interpret slot removal as completion", () => {
    const { emit, forward } = setup()
    forward(view({ run, tools: [tool()], nestedTools: [nested()] }), view())
    expect(emit).not.toHaveBeenCalled()
  })

  it("does not deduplicate reused direct or nested call IDs across tasks", () => {
    const { emit, forward } = setup()
    const entries = [entry(1, [assistant()])]
    forward(
      view({ run, tools: [tool()], nestedTools: [nested()] }, entries),
      view(
        {
          run,
          tools: [tool({ taskId: 30 as TaskId })],
          nestedTools: [nested({ taskId: 31 as TaskId, parentTaskId: 30 as TaskId })],
        },
        entries,
      ),
    )
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      {
        type: "tool_execution_start",
        toolCallId: "call",
        toolName: "read",
        args: { path: "current" },
      },
      {
        type: "tool_execution_start",
        toolCallId: "call/child",
        toolName: "read",
        parentToolCallId: "call",
        args: { path: "nested" },
      },
    ])
  })

  it("emits only the first model message of newly appended model-bearing entries", () => {
    const { emit, forward } = setup()
    const message: Message = { role: "user", content: "first", timestamp: 0 }
    forward(
      view({}, [entry(1, [assistant()])]),
      view({}, [entry(1, [assistant()]), entry(2), entry(3, []), entry(4, [message, toolResult])]),
    )
    expect(emit).toHaveBeenCalledExactlyOnceWith({ type: "message_end", message })
  })

  it("does not replay history when a bounded window drops or restores older entries", () => {
    const { emit, forward } = setup()
    const records = Array.from({ length: 104 }, (_, index) => entry(index + 1, [assistant()]))
    forward(view({}, records.slice(0, 100)), view({}, records.slice(51, 102), 51))
    forward(view({}, records.slice(51, 102), 51), view({}, records.slice(52, 103), 52))
    forward(view({}, records.slice(52, 103), 52), view({}, records.slice(0, 103)))
    expect(emit.mock.calls.map(([event]) => event)).toEqual(
      records
        .slice(100, 103)
        .map((record) => ({ type: "message_end", message: record.model?.[0] })),
    )
  })

  it("uses before as the high-water mark when an attachment window is empty", () => {
    const { emit, forward } = setup()
    forward(view({}, [], 5), view({}, [entry(4, [assistant()]), entry(6, [toolResult])], 3))
    expect(emit).toHaveBeenCalledExactlyOnceWith({ type: "message_end", message: toolResult })
  })

  it.each(["running", "done"] as const)(
    "does not replay unchanged or restored %s views",
    (status) => {
      const { emit, logger, forward } = setup()
      const snapshot = view(
        {
          run,
          tools: [tool({ status, entry: 3 as EntryId })],
          nestedTools: [nested({ status, summary: { isError: false } })],
          generation: { attempt: 2, retry: { at: 100, error: "retry" } },
          compactions: [
            {
              taskId: 40 as TaskId<CompactionResult>,
              trigger: "threshold",
              blocking: true,
              attempt: 1,
            },
          ],
        },
        [entry(2, [assistant()]), entry(3, [toolResult])],
      )
      forward(snapshot, snapshot)
      forward(snapshot, structuredClone(snapshot))
      expect(emit).not.toHaveBeenCalled()
      expect(logger.info).not.toHaveBeenCalled()
    },
  )

  it("logs each retry start but not retry updates or removal", () => {
    const { emit, logger, forward } = setup()
    const first = view({ generation: { attempt: 2, retry: { at: 100, error: "retry" } } })
    const second = view({ generation: { attempt: 3, retry: { at: 200, error: "retry" } } })
    forward(view(), first)
    forward(first, structuredClone(first))
    forward(first, view({ generation: { attempt: 2 } }))
    forward(view({ generation: { attempt: 2 } }), second)
    expect(logger.info.mock.calls).toEqual([
      ["Durable retry session_id=session attempt=2"],
      ["Durable retry session_id=session attempt=3"],
    ])
    expect(emit).not.toHaveBeenCalled()
  })

  it("logs compaction starts and ends with trigger, including failure", () => {
    const { emit, logger, forward } = setup()
    const first = view({
      compactions: [
        {
          taskId: 40 as TaskId<CompactionResult>,
          trigger: "threshold",
          blocking: true,
          attempt: 1,
        },
      ],
    })
    const next = view({
      compactions: [
        { taskId: 41 as TaskId<CompactionResult>, trigger: "manual", blocking: false, attempt: 1 },
      ],
      compactionFailure: {
        taskId: 40 as TaskId<CompactionResult>,
        trigger: "threshold",
        error: "fault",
      },
    })
    forward(view(), first)
    forward(first, next)
    forward(next, view())
    expect(logger.info.mock.calls).toEqual([
      ["Durable compaction_start session_id=session task_id=40 trigger=threshold"],
      ["Durable compaction_start session_id=session task_id=41 trigger=manual"],
      ["Durable compaction_end session_id=session task_id=40 trigger=threshold"],
      ["Durable compaction_end session_id=session task_id=41 trigger=manual"],
    ])
    expect(emit).not.toHaveBeenCalled()
  })
})
