import type { Policy } from "@narumitw/sumire-policy"
import { expect, expectTypeOf, it } from "vitest"
import type {
  AuditEntry,
  Chat,
  ChatResponse,
  ImportReport,
  Inventory,
  Snapshot,
} from "../src/index.js"

it("defines shared wire types without runtime dependencies", async () => {
  expectTypeOf<Snapshot["policy"]>().toEqualTypeOf<Policy>()
  expectTypeOf<Snapshot["epoch"]>().toEqualTypeOf<number>()
  expectTypeOf<ChatResponse>().toExtend<Chat>()
  expectTypeOf<AuditEntry["revision"]>().toEqualTypeOf<number>()
  expectTypeOf<ImportReport["report"]>().toEqualTypeOf<Record<string, unknown>>()
  expectTypeOf<Inventory["mcp"][number]["env"]>().toEqualTypeOf<Record<string, null>>()
  expect(Object.keys(await import("../src/index.js"))).toEqual([])
})
