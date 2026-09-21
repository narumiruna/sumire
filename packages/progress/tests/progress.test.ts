import type { JsonValue } from "@earendil-works/pi-ai"
import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"

import progressExtension from "../src/progress-extension.js"
import {
  PROGRESS_CONTEXT_MESSAGE_TYPE,
  PROGRESS_DETAILS_VERSION,
  PROGRESS_TOOL_NAME,
  type ProgressStep,
  parseProgressDetails,
  reconcileProgressContext,
  reconstructProgress,
  validateProgressArguments,
} from "../src/progress-state.js"

type Handler = (event: never, ctx: ExtensionContext) => unknown

interface RegisteredTool {
  name: string
  promptGuidelines: string[]
  prepareArguments(value: unknown): { steps: ProgressStep[] }
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ): Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>
}

describe("progress state", () => {
  it("accepts canonical progress and rejects invalid invariants", () => {
    expect(
      validateProgressArguments({
        steps: [
          { text: "inspect", status: "completed" },
          { text: "implement", status: "in_progress" },
          { text: "release", status: "blocked", reason: "approval" },
        ],
      }),
    ).toEqual({
      steps: [
        { text: "inspect", status: "completed" },
        { text: "implement", status: "in_progress" },
        { text: "release", status: "blocked", reason: "approval" },
      ],
    })
    expect(() =>
      validateProgressArguments({
        steps: [
          { text: "one", status: "in_progress" },
          { text: "two", status: "in_progress" },
        ],
      }),
    ).toThrow(/at most one in_progress/iu)
    expect(() =>
      validateProgressArguments({ steps: [{ text: "release", status: "blocked" }] }),
    ).toThrow(/requires a non-whitespace reason/iu)
    expect(() => validateProgressArguments({ steps: [{ text: " ", status: "pending" }] })).toThrow(
      /non-whitespace text/iu,
    )
  })

  it("parses and restores only successful canonical results", () => {
    const valid = {
      version: PROGRESS_DETAILS_VERSION,
      steps: [{ text: "restore", status: "pending" }],
    }
    expect(parseProgressDetails(valid)).toEqual(valid)
    expect(parseProgressDetails({ ...valid, extra: true })).toBeUndefined()
    expect(
      reconstructProgress([
        resultEntry({ version: 1, steps: [{ text: "old", status: "completed" }] }, "old"),
        resultEntry({ version: 1, steps: "invalid" }, "invalid"),
        resultEntry(valid, "valid"),
      ]),
    ).toEqual(valid.steps)
  })

  it("adds hidden progress context only when compacted history lacks current state", () => {
    const steps: ProgressStep[] = [{ text: "continue", status: "in_progress" }]
    const messages: ContextEvent["messages"] = [
      {
        role: "compactionSummary",
        summary: "Earlier work",
        tokensBefore: 100,
        timestamp: 0,
      },
      { role: "user", content: [{ type: "text", text: "go" }], timestamp: 0 },
    ]
    const reconciled = reconcileProgressContext(messages, steps)
    expect(reconciled[1]).toMatchObject({
      role: "custom",
      customType: PROGRESS_CONTEXT_MESSAGE_TYPE,
      display: false,
    })

    const visible = [
      ...messages,
      {
        role: "toolResult",
        toolCallId: "progress",
        toolName: PROGRESS_TOOL_NAME,
        content: [{ type: "text", text: "updated" }],
        details: toJson({ version: 1, steps }),
        isError: false,
        timestamp: 0,
      },
    ] as ContextEvent["messages"]
    expect(reconcileProgressContext(visible, steps)).toBe(visible)
  })
})

describe("progress extension", () => {
  it("registers one tool and persists versioned progress details", async () => {
    const handlers = new Map<string, Handler[]>()
    const tools: RegisteredTool[] = []
    const pi = {
      on(event: string, handler: Handler) {
        handlers.set(event, [...(handlers.get(event) ?? []), handler])
      },
      registerTool(tool: RegisteredTool) {
        tools.push(tool)
      },
    } as unknown as ExtensionAPI
    progressExtension(pi)

    expect(tools.map((tool) => tool.name)).toEqual([PROGRESS_TOOL_NAME])
    expect(tools[0]?.promptGuidelines).toContain(
      "Use update_progress to track work with multiple meaningful steps; skip it for simple, single-step tasks.",
    )

    const branch: SessionEntry[] = []
    const ctx = {
      mode: "print",
      hasUI: false,
      sessionManager: { getBranch: () => branch },
    } as unknown as ExtensionContext
    for (const handler of handlers.get("session_start") ?? []) await handler({} as never, ctx)

    const result = await tools[0]?.execute(
      "progress",
      { steps: [{ text: "work", status: "in_progress" }] },
      undefined,
      undefined,
      ctx,
    )
    expect(result?.details).toEqual({
      version: PROGRESS_DETAILS_VERSION,
      steps: [{ text: "work", status: "in_progress" }],
    })
    expect(result?.content[0]?.text).toContain("1 in progress")
  })
})

function resultEntry(details: unknown, id: string): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: new Date(0).toISOString(),
    message: {
      role: "toolResult",
      toolCallId: id,
      toolName: PROGRESS_TOOL_NAME,
      content: [{ type: "text", text: "updated" }],
      details: toJson(details),
      isError: false,
      timestamp: 0,
    },
  } as SessionEntry
}

function toJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(toJson)
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) =>
        item === undefined ? [] : [[key, toJson(item)]],
      ),
    )
  }
  throw new TypeError("Fixture must be JSON-compatible")
}
