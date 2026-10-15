import { describe, expect, it } from "vitest"
import { parseIds } from "./api.js"

describe("Telegram access IDs", () => {
  it("normalizes explicit private-user and group lists independently", () => {
    expect(parseIds("42, 43 42", true)).toEqual([42, 43])
    expect(parseIds("-100,-200", false)).toEqual([-100, -200])
    expect(parseIds("", true)).toEqual([])
  })
  it.each(["0", "-100", "1.5", "9007199254740992", "x"])("rejects invalid private ID %s", (value) =>
    expect(() => parseIds(value, true)).toThrow(),
  )
  it("rejects positive group IDs", () => expect(() => parseIds("42", false)).toThrow())
})
