import { describe, expect, it } from "vitest"
import { countNouns, countText } from "./status-text.js"

describe("status counts", () => {
  it.each(Object.keys(countNouns) as (keyof typeof countNouns)[])(
    "selects native plural forms for %s",
    (noun) => {
      const plural = noun === "entry" ? "entries" : noun === "chat has" ? "chats have" : `${noun}s`
      expect(countText(0, noun)).toBe(`0 ${plural}`)
      expect(countText(1, noun)).toBe(`1 ${noun}`)
      expect(countText(2, noun)).toBe(`2 ${plural}`)
      expect(countText(1.5, noun)).toBe(`1.5 ${plural}`)
    },
  )
  it.each([
    [0, "0 pending policy changes"],
    [1, "1 pending policy change"],
    [2, "2 pending policy changes"],
  ])("uses agreement for %i", (count, expected) => {
    expect(countText(count, "pending policy change")).toBe(expected)
  })
  it("supports irregular plurals and verbs", () => {
    expect(countText(0, "entry")).toBe("0 entries")
    expect(countText(1, "chat has")).toBe("1 chat has")
    expect(countText(2, "chat has")).toBe("2 chats have")
  })
})
