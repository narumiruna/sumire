import type {
  DurableConversationItem,
  DurableDocumentItem,
  DurableDocumentProjection,
  DurableEntryItem,
  DurableTaskItem,
} from "@narumitw/sumire-contracts"
import { describe, expect, it } from "vitest"
import {
  formatDurableTime,
  formatReadTime,
  recordSummary,
  recordTitle,
  taskObservation,
} from "./durable-presentation.js"

const conversation: DurableConversationItem = { type: "conversation", id: 7, active: false }
const task: DurableTaskItem = {
  type: "task",
  id: 8,
  conversationId: 7,
  kind: "pi.generation",
  version: 1,
  background: false,
  abortRequested: false,
  status: "pending",
}
const document: DurableDocumentItem = {
  type: "document",
  id: 9,
  kind: "pi.agent",
  scope: { kind: "session" },
  family: false,
  createdAt: 42,
  valueState: "metadata-only",
}
const entry: DurableEntryItem = { type: "entry", id: 10, conversationId: 7, kind: "message" }

const outcomes = [
  ["completed", "Completed"],
  ["failed", "Failed"],
  ["aborted", "Aborted"],
  ["orphaned", "Orphaned"],
  ["faulted", "Faulted"],
] as const
const statuses = [
  ["pending", "Pending"],
  ["running", "Running"],
  ["waiting", "Waiting"],
  ["completing", "Completing"],
  ["terminal", "Terminal"],
] as const

describe("Durable record titles", () => {
  it("distinguishes persisted selection, branches, and historical conversations", () => {
    expect(recordTitle(conversation)).toBe("Historical conversation")
    const branch = { ...conversation, parent: { conversationId: 3, at: 4 } }
    expect(recordTitle(branch)).toBe("Conversation branch")
    expect(recordTitle({ ...branch, active: true })).toBe("Selected conversation")
    expect(recordTitle({ ...conversation, active: true })).toBe("Selected conversation")
  })

  it.each([
    ["pi.generation", "Model response"],
    ["pi.tool", "Tool call"],
    ["pi.compaction", "Context compaction"],
    ["sumire.codemode-call", "Task"],
    ["future.task", "Task"],
    ["", "Task"],
  ])("labels task kind %s", (kind, title) => {
    expect(recordTitle({ ...task, kind })).toBe(title)
  })

  it.each([
    ["pi.agent", "Model settings"],
    ["pi.usage", "Model usage"],
    ["sumire.session", "Session selection"],
    ["future.document", "Document"],
    ["", "Document"],
  ])("labels document kind %s", (kind, title) => {
    expect(recordTitle({ ...document, kind })).toBe(title)
  })

  it.each([
    ["assistant", "Assistant message record"],
    ["user", "User message record"],
    ["system", "System message record"],
    ["toolResult", "Tool result record"],
    [undefined, "Entry record"],
  ] as const)("labels entry role %s without interpreting its kind", (role, title) => {
    expect(recordTitle({ ...entry, role })).toBe(title)
    expect(recordTitle({ ...entry, role, kind: "future.entry" })).toBe(title)
  })

  it.each(["<img src=x onerror=alert(1)>", "&lt;script&gt;", "__proto__", "constructor"])(
    "does not interpret or interpolate untrusted kind %s",
    (kind) => {
      expect(recordTitle({ ...task, kind })).toBe("Task")
      expect(recordTitle({ ...document, kind })).toBe("Document")
      expect(recordTitle({ ...entry, kind })).toBe("Entry record")
      expect(recordSummary({ ...task, kind })).toBe(
        "Recorded status: Pending · no outcome recorded",
      )
      expect(
        recordSummary({
          ...document,
          kind,
          valueState: "withheld",
          withheldReason: "unknown-kind",
        }),
      ).toBe("This document is not approved for value inspection.")
      expect(recordSummary({ ...entry, kind })).toBe("Message content is not included.")
    },
  )
})

describe("stored task observations", () => {
  it.each(outcomes)("reports only the recorded %s outcome", (outcome, label) => {
    for (const [status] of statuses) {
      const item = { ...task, status, outcome }
      expect(taskObservation(item)).toBe(`Recorded outcome: ${label}`)
      expect(recordSummary(item)).toBe(taskObservation(item))
    }
  })

  it.each(statuses)("does not infer an outcome from %s", (status, label) => {
    const item = { ...task, status }
    const expected = `Recorded status: ${label} · no outcome recorded`
    expect(taskObservation(item)).toBe(expected)
    expect(recordSummary(item)).toBe(expected)
    expect(taskObservation({ ...item, outcome: undefined })).toBe(expected)
    expect(taskObservation({ ...item, abortRequested: true, background: true, endedAt: 123 })).toBe(
      expected,
    )
  })
})

describe("structured record summaries", () => {
  it("reports only recorded parent relationships", () => {
    expect(recordSummary(conversation)).toBe("No parent relationship recorded.")
    expect(recordSummary({ ...conversation, active: true })).toBe(
      "No parent relationship recorded.",
    )
    expect(recordSummary({ ...conversation, owner: { conversationId: 2, taskId: 3 } })).toBe(
      "No parent relationship recorded.",
    )
    expect(recordSummary({ ...conversation, parent: { conversationId: 3, at: 4 } })).toBe(
      "Branched from conversation 3 at entry 4.",
    )
  })

  it("does not include entry content for any role", () => {
    for (const role of [undefined, "assistant", "user", "system", "toolResult"] as const) {
      expect(recordSummary({ ...entry, role })).toBe("Message content is not included.")
    }
  })

  it("distinguishes metadata-only and unavailable document values", () => {
    expect(recordSummary(document)).toBe(
      "Only metadata is included. Inspect this document to read approved fields.",
    )
    expect(recordSummary({ ...document, valueState: "unavailable" })).toBe(
      "The document value is unavailable.",
    )
  })

  it.each([
    { kind: "pi.agent", model: { provider: "example", modelId: "test-model" } },
    { kind: "pi.usage", models: {}, total: {} },
    { kind: "sumire.session", activeConversation: 7 },
  ] satisfies DurableDocumentProjection[])(
    "explains available $kind projection fields",
    (value) => {
      expect(recordSummary({ ...document, kind: value.kind, valueState: "available", value })).toBe(
        "Approved document fields are available.",
      )
    },
  )

  it.each([
    ["unknown-kind", "This document is not approved for value inspection."],
    [
      "invalid-value",
      "The document value is withheld because it does not match the approved format.",
    ],
    ["limit", "The document value is withheld because it exceeds inspection limits."],
    [undefined, "The document value is withheld. No reason is recorded."],
  ] as const)("explains withheld reason %s without guessing", (withheldReason, expected) => {
    expect(recordSummary({ ...document, valueState: "withheld", withheldReason })).toBe(expected)
  })

  it("does not read document creation and retirement commit sequences as dates", () => {
    // Installed Durable types.d.ts defines these as Seq, not wall-clock milliseconds.
    const item: DurableDocumentItem = {
      ...document,
      get createdAt(): number {
        throw new Error("createdAt is a commit sequence")
      },
      get retiredAt(): number {
        throw new Error("retiredAt is a commit sequence")
      },
    }
    expect(recordTitle(item)).toBe("Model settings")
    expect(recordSummary(item)).toBe(
      "Only metadata is included. Inspect this document to read approved fields.",
    )
  })
})

describe("deterministic Durable UTC times", () => {
  it("formats Date.now wall-clock milliseconds without a seconds conversion", () => {
    // Verified in installed Durable session/session.js and types.d.ts task time fields.
    expect(formatDurableTime(1_792_411_200_000)).toBe("2026-10-19 12:00:00 UTC")
    expect(formatDurableTime(0)).toBe("1970-01-01 00:00:00 UTC")
    expect(formatDurableTime(1)).toBe("1970-01-01 00:00:00 UTC")
    expect(formatDurableTime(8_640_000_000_000_000)).toBe("+275760-09-13 00:00:00 UTC")
  })

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
    0.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MAX_SAFE_INTEGER,
    8_640_000_000_000_001,
  ])("does not format missing or invalid milliseconds %s", (value) => {
    expect(formatDurableTime(value)).toBe("Not recorded")
  })

  it.each([
    ["2026-10-19T12:00:00.000Z", "2026-10-19 12:00:00 UTC"],
    ["2026-10-19T12:00:00Z", "2026-10-19 12:00:00 UTC"],
    ["2026-10-19T14:30:00.123+02:30", "2026-10-19 12:00:00 UTC"],
    ["2026-10-19T08:00:00-04:00", "2026-10-19 12:00:00 UTC"],
    ["1970-01-01T00:00:00Z", "1970-01-01 00:00:00 UTC"],
    ["1969-12-31T23:59:59Z", "1969-12-31 23:59:59 UTC"],
    ["2024-02-29T00:00:00Z", "2024-02-29 00:00:00 UTC"],
  ])("formats structured ISO read time %s", (value, expected) => {
    expect(formatReadTime(value)).toBe(expected)
  })

  it.each([
    "",
    "not a date",
    "19 Oct 2026, 12:00:00 UTC",
    "2026-10-19",
    "2026-10-19T12:00:00",
    "2026-10-19 12:00:00Z",
    "2026-10-19T24:00:00Z",
    "2026-10-19T12:60:00Z",
    "2026-10-19T12:00:60Z",
    "2026-02-30T12:00:00Z",
    "2026-02-29T12:00:00Z",
    "2026-13-01T12:00:00Z",
    "2026-00-01T12:00:00Z",
    "2026-10-00T12:00:00Z",
    "2026-10-19T12:00:00+24:00",
    "2026-10-19T12:00:00+00:60",
    "+275761-01-01T00:00:00.000Z",
    " 2026-10-19T12:00:00Z ",
    "<time>2026-10-19T12:00:00Z</time>",
  ])("rejects invalid or unstructured read time %s", (value) => {
    expect(formatReadTime(value)).toBe("Read time unavailable")
  })
})
