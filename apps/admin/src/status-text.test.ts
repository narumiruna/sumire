import { describe, expect, it } from "vitest"
import { countText } from "./status-text.js"

describe("status counts", () => {
  it.each([
    [0, "0 pending policy changes"],
    [1, "1 pending policy change"],
    [2, "2 pending policy changes"],
  ])("uses agreement for %i", (count, expected) => {
    expect(countText(count, "pending policy change")).toBe(expected)
  })
  it("supports irregular plurals and verbs", () => {
    expect(countText(0, "entry", "entries")).toBe("0 entries")
    expect(countText(1, "chat has", "chats have")).toBe("1 chat has")
    expect(countText(2, "chat has", "chats have")).toBe("2 chats have")
  })
})
