import type {
  DurableConversationItem,
  DurableInspectionResponse,
  DurableInspectionView,
} from "@narumitw/sumire-contracts"
import { describe, expect, it } from "vitest"
import {
  durableHref,
  inspectionPath,
  persistedSelection,
  readDurableContext,
  readDurableLocation,
} from "./durable-inspector.js"

const base = "https://example.com/admin?section=Durable&chat=-100"
const selected: DurableConversationItem = { type: "conversation", id: 99, active: true }
const loaded = (
  view: DurableInspectionView,
  selection: DurableConversationItem | null = selected,
): DurableInspectionResponse => ({
  version: 1,
  state: "loaded",
  view,
  items: view === "conversations" ? [{ type: "conversation", id: 7, active: false }] : [],
  selectedConversation: selection,
  readAt: `2026-10-19T12:00:0${view === "conversations" ? 1 : 2}.000Z`,
  truncated: false,
})

describe("bounded Durable overview reads", () => {
  it("uses off-page persisted selection without inferring from rows or the URL", async () => {
    const calls: string[] = []
    const published = new Map<string, { data?: DurableInspectionResponse }>()
    await readDurableContext(
      "42",
      { view: "conversations", conversationId: 7 },
      undefined,
      async (path) => {
        calls.push(path)
        return { data: loaded(path.includes("view=tasks") ? "tasks" : "conversations") }
      },
      (name, block) => {
        published.set(name, block)
      },
    )
    expect(calls).toEqual([
      "chats/42/durable?view=conversations&limit=25",
      "chats/42/durable?view=tasks&limit=25&conversationId=99",
    ])
    expect(published.get("inspection")).toBe(published.get("selection"))
    expect(persistedSelection(published.get("selection")?.data)?.id).toBe(99)
    expect(published.get("selection")?.data?.readAt).not.toBe(
      published.get("history")?.data?.readAt,
    )
  })
  it("reuses an identical requested task page and sequences every read", async () => {
    const order: string[] = []
    let active = false
    await readDurableContext(
      "42",
      { view: "tasks", conversationId: 99 },
      undefined,
      async (path) => {
        expect(active).toBe(false)
        active = true
        order.push(path)
        await Promise.resolve()
        active = false
        return { data: loaded(path.includes("view=tasks") ? "tasks" : "conversations") }
      },
      (name) => {
        order.push(name)
      },
    )
    expect(order).toEqual([
      "chats/42/durable?view=conversations&limit=25",
      "selection",
      "chats/42/durable?view=tasks&limit=25&conversationId=99",
      "history",
      "inspection",
    ])
  })
  it("reads at most three bounded pages and preserves an independent partial error", async () => {
    const calls: string[] = []
    const published: Record<string, { error?: string; data?: DurableInspectionResponse }> = {}
    await readDurableContext(
      "42",
      { view: "documents", scope: "session", objectId: 201 },
      undefined,
      async (path) => {
        calls.push(path)
        return path.includes("view=tasks")
          ? { error: "Read failed" }
          : { data: loaded(path.includes("view=documents") ? "documents" : "conversations") }
      },
      (name, block) => {
        published[name] = block
      },
    )
    expect(calls).toHaveLength(3)
    expect(calls.every((path) => path.includes("limit=25"))).toBe(true)
    expect(published.history?.error).toBe("Read failed")
    expect(published.selection?.data).toBeDefined()
    expect(published.inspection?.data?.view).toBe("documents")
  })
  it("never scans for absent selection and does not infer it from active markers", async () => {
    const data = loaded("conversations", null)
    if (data.state === "loaded") data.items = [{ type: "conversation", id: 7, active: true }]
    expect(persistedSelection(data)).toBeNull()
    if (data.state === "loaded") delete data.selectedConversation
    expect(persistedSelection(data)).toBeUndefined()
    let calls = 0
    await readDurableContext(
      "42",
      { view: "conversations" },
      undefined,
      async () => {
        calls++
        return { data }
      },
      () => {},
    )
    expect(calls).toBe(1)
  })
  it("keeps opaque pagination bounded while selection remains independent", async () => {
    const calls: string[] = []
    await readDurableContext(
      "42",
      { view: "conversations" },
      "opaque+/=token",
      async (path) => {
        calls.push(path)
        return { data: loaded("conversations") }
      },
      () => {},
    )
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain("cursor=opaque%2B%2F%3Dtoken")
    expect(calls[1]).not.toContain("cursor=")
  })
  it("reads an off-page conversation by object ID without changing persisted selection", async () => {
    const calls: string[] = []
    const published = new Map<string, { data?: DurableInspectionResponse }>()
    await readDurableContext(
      "42",
      { view: "conversations", objectId: 9 },
      undefined,
      async (path) => {
        calls.push(path)
        const data = loaded(path.includes("view=tasks") ? "tasks" : "conversations")
        if (path.includes("objectId=9"))
          data.items = [{ type: "conversation", id: 9, active: false }]
        return { data }
      },
      (name, block) => {
        published.set(name, block)
      },
    )
    expect(calls).toEqual([
      "chats/42/durable?view=conversations&limit=25",
      "chats/42/durable?view=tasks&limit=25&conversationId=99",
      "chats/42/durable?view=conversations&limit=25&objectId=9",
    ])
    expect(persistedSelection(published.get("selection")?.data)?.id).toBe(99)
    expect(published.get("inspection")?.data?.items).toEqual([
      { type: "conversation", id: 9, active: false },
    ])
  })
  it("stops after an unloaded session or cancellation without speculative reads", async () => {
    let calls = 0
    await readDurableContext(
      "42",
      { view: "documents", scope: "session" },
      undefined,
      async () => {
        calls++
        return {
          data: {
            version: 1,
            state: "not-loaded",
            view: "conversations",
            items: [],
            readAt: "2026-10-19T12:00:00Z",
            truncated: false,
          },
        }
      },
      () => {},
    )
    expect(calls).toBe(1)
    await expect(
      readDurableContext(
        "42",
        { view: "conversations" },
        undefined,
        async () => {
          throw new DOMException("Cancelled", "AbortError")
        },
        () => {},
      ),
    ).rejects.toThrow("Cancelled")
  })
})
describe("Durable Inspector navigation", () => {
  it("restores object and scope context from a deep link", () => {
    expect(
      readDurableLocation(
        new URL(`${base}&view=documents&scope=task&conversationId=7&taskId=8&objectId=9`),
      ),
    ).toEqual({ view: "documents", scope: "task", conversationId: 7, taskId: 8, objectId: 9 })
  })
  it("rejects malformed and unsafe object IDs", () => {
    for (const id of ["0", "-1", "01", "1.5", "9007199254740992", "<script>"]) {
      const url = new URL(base)
      for (const key of ["conversationId", "taskId", "objectId"]) url.searchParams.set(key, id)
      expect(readDurableLocation(url)).toEqual({ view: "conversations" })
    }
    expect(readDurableLocation(new URL(`${base}&view=unknown`))).toEqual({ view: "conversations" })
  })
  it("makes same-path links with no previous object or cursor", () => {
    expect(
      durableHref(
        "-100",
        { view: "entries", conversationId: 7 },
        new URL(`${base}&view=documents&scope=task&objectId=8&taskId=9`),
      ),
    ).toBe("/admin?section=Durable&chat=-100&view=entries&conversationId=7")
  })
  it("keeps a conversation object deep link separate from the persisted selection context", () => {
    const location = readDurableLocation(new URL(`${base}&view=conversations&objectId=9`))
    expect(location).toEqual({ view: "conversations", objectId: 9 })
    expect(inspectionPath("-100", location)).toBe(
      "chats/-100/durable?view=conversations&limit=25&objectId=9",
    )
    expect(durableHref("-100", { view: "tasks", conversationId: 9 }, new URL(base))).toBe(
      "/admin?section=Durable&chat=-100&view=tasks&conversationId=9",
    )
  })
  it("sends only scope-relevant IDs and an encoded opaque cursor at a fixed page size", () => {
    const context = { conversationId: 7, taskId: 8, objectId: 9 }
    expect(
      inspectionPath("-100", { view: "documents", scope: "task", ...context }, "opaque+/= token"),
    ).toBe(
      "chats/-100/durable?view=documents&limit=25&conversationId=7&scope=task&taskId=8&objectId=9&cursor=opaque%2B%2F%3D+token",
    )
    expect(inspectionPath("-100", { view: "documents", scope: "session", ...context })).toBe(
      "chats/-100/durable?view=documents&limit=25&scope=session&objectId=9",
    )
    expect(inspectionPath("-100", { view: "conversations", ...context })).toBe(
      "chats/-100/durable?view=conversations&limit=25&objectId=9",
    )
  })
})
