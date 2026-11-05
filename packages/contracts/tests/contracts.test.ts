import type { Policy } from "@narumitw/sumire-policy"
import { expect, expectTypeOf, it } from "vitest"
import type {
  AuditEntry,
  Chat,
  ChatResponse,
  DurableConversationItem,
  DurableEntryItem,
  DurableInspectionLoadedResponse,
  DurableInspectionQuery,
  DurableInspectionResponse,
  DurableInspectionView,
  ImportReport,
  Inventory,
  McpObservation,
  McpObservationFailure,
  Snapshot,
} from "../src/index.js"

it("defines shared wire types without runtime dependencies", async () => {
  expectTypeOf<Snapshot["policy"]>().toEqualTypeOf<Policy>()
  expectTypeOf<Snapshot["epoch"]>().toEqualTypeOf<number>()
  expectTypeOf<ChatResponse>().toExtend<Chat>()
  expectTypeOf<DurableInspectionLoadedResponse["selectedConversation"]>().toEqualTypeOf<
    DurableConversationItem | null | undefined
  >()
  const oldResponse: DurableInspectionLoadedResponse = {
    version: 1,
    state: "loaded",
    readAt: "2026-10-19T00:00:00.000Z",
    view: "conversations",
    items: [],
    truncated: false,
  }
  expect(oldResponse).not.toHaveProperty("selectedConversation")
  const noSelection: DurableInspectionLoadedResponse = {
    ...oldResponse,
    selectedConversation: null,
  }
  expect(noSelection.selectedConversation).toBeNull()
  expectTypeOf<AuditEntry["revision"]>().toEqualTypeOf<number>()
  expectTypeOf<ImportReport["report"]>().toEqualTypeOf<Record<string, unknown>>()
  expectTypeOf<Inventory["mcp"][number]["env"]>().toEqualTypeOf<Record<string, null>>()
  expect(Object.keys(await import("../src/index.js"))).toEqual([])
})

it("adds optional structured MCP observations without changing legacy fields", () => {
  const legacy: Inventory["mcp"][number] = {
    name: "fixture",
    connection: "no visible tools or unavailable",
    tools: [],
    env: {},
    headers: {},
  }
  expect(legacy.observation).toBeUndefined()
  expectTypeOf<Inventory["mcp"][number]["observation"]>().toEqualTypeOf<
    McpObservation | undefined
  >()
  const observations: McpObservation[] = [
    { state: "untested" },
    { state: "checking", revision: 2, startedAt: 1000 },
    { state: "succeeded", revision: 2, completedAt: 2000 },
    { state: "failed", revision: 2, completedAt: 2000, reason: "listing" },
  ]
  expect(observations.map((observation) => ({ ...legacy, observation }).observation.state)).toEqual(
    ["untested", "checking", "succeeded", "failed"],
  )
  expectTypeOf<McpObservationFailure>().toEqualTypeOf<
    "transport" | "listing" | "timeout" | "cancelled"
  >()
  expectTypeOf<{ state: "succeeded" }>().not.toExtend<McpObservation>()
  expectTypeOf<{
    state: "failed"
    revision: number
    completedAt: number
    reason: "raw private error"
  }>().not.toExtend<McpObservation>()
})

it("adds history with the existing bounded entry content shape and response envelope", () => {
  expectTypeOf<"history">().toExtend<DurableInspectionView>()
  expectTypeOf<DurableInspectionQuery["view"]>().toEqualTypeOf<DurableInspectionView>()
  const query: DurableInspectionQuery = { view: "history", conversationId: 1, limit: 25 }
  const entry: DurableEntryItem = {
    type: "entry",
    id: 2,
    conversationId: 1,
    kind: "pi.user",
    content: {
      messages: [{ role: "user", content: [{ type: "text", text: "Saved input" }] }],
      truncated: false,
    },
  }
  const history: DurableInspectionResponse = {
    version: 1,
    state: "loaded",
    readAt: "2026-10-30T00:00:00.000Z",
    view: query.view,
    items: [entry],
    nextCursor: "opaque-query-bound-cursor",
    truncated: false,
  }
  expect(history.items).toEqual([entry])
  const metadataOnly: DurableEntryItem = {
    type: "entry",
    id: 2,
    conversationId: 1,
    kind: "pi.user",
  }
  expect(metadataOnly).not.toHaveProperty("content")
  const unloaded: DurableInspectionResponse = {
    version: 1,
    state: "not-loaded",
    readAt: history.readAt,
    view: "history",
    items: [],
    truncated: false,
  }
  expect(unloaded.view).toBe("history")
})
