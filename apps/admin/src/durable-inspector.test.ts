import { describe, expect, it } from "vitest"
import { durableHref, inspectionPath, readDurableLocation } from "./durable-inspector.js"

const base = "https://example.com/admin?section=Durable&chat=-100"
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
