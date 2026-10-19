import type { Policy } from "@narumitw/sumire-policy"
import { expect, expectTypeOf, it } from "vitest"
import type {
  AuditEntry,
  Chat,
  ChatResponse,
  DurableConversationItem,
  DurableInspectionLoadedResponse,
  ImportReport,
  Inventory,
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
