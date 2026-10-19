import type { Chat } from "@narumitw/sumire-contracts"
import { describe, expect, it } from "vitest"
import { chatName, directoryPath } from "./chat-directory.js"

describe("stored chat display names", () => {
  it("trims observed names without interpreting untrusted markup", () => {
    expect(chatName({ id: -100, type: "supergroup", name: "  Same name  " })).toBe("Same name")
    expect(chatName({ id: 42, type: "private", name: "<img src=x onerror=alert(1)>" })).toBe(
      "<img src=x onerror=alert(1)>",
    )
  })

  it.each([
    [-100, "supergroup", "", "Unnamed supergroup"],
    [-100, "group", " \t\n ", "Unnamed group"],
    [42, "private", "42", "Unnamed private"],
    [-100, "channel", " -100 ", "Unnamed channel"],
    [-100, "", "", "Unnamed chat"],
  ])("uses a neutral label for %s / %s / %j", (id, type, name, expected) => {
    const label = chatName({ id, type, name } as Chat)
    expect(label).toBe(expected)
    expect(label).not.toContain(String(id))
  })

  it("does not rewrite a numeric observed name or append IDs to duplicate names", () => {
    expect(chatName({ id: 42, type: "private", name: "43" })).toBe("43")
    for (const id of [-100, -200])
      expect(chatName({ id, type: "group", name: "Same name" })).toBe("Same name")
  })
})

describe("stored directory request paths", () => {
  it("keeps unfiltered paginated callers compatible", () => {
    expect(directoryPath(0)).toBe("chats?offset=0")
    expect(directoryPath(100, " \t ")).toBe("chats?offset=100")
    expect(directoryPath(200)).toBe("chats?offset=200")
  })

  it("sends complete negative IDs and names as server-side query parameters", () => {
    expect(directoryPath(0, " -1001234567890 ")).toBe("chats?offset=0&q=-1001234567890")
    const path = new URL(directoryPath(100, " A&B / 日本語_%? "), "https://example.test/")
    expect(path.searchParams.get("offset")).toBe("100")
    expect(path.searchParams.get("q")).toBe("A&B / 日本語_%?")
    expect([...path.searchParams.keys()]).toEqual(["offset", "q"])
  })
})
