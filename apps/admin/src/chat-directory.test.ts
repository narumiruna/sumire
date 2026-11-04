import type { Chat } from "@narumitw/sumire-contracts"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { type ChatDirectory, ChatSelector, chatName, directoryPath } from "./chat-directory.js"
import { Check } from "./policy-editors.js"

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

describe("directory selection semantics", () => {
  it("supports notification checkboxes and unique status descriptions in mounted directories", () => {
    const chat: Chat = { id: 42, type: "private", name: "<unsafe>" }
    const directory: ChatDirectory = {
      chats: [chat],
      knownChats: [chat],
      loading: false,
      error: "",
      query: "",
      offset: 0,
      setQuery: vi.fn(),
      setOffset: vi.fn(),
      refresh: vi.fn(),
      selected: { loading: false, error: "", chat: undefined },
    }
    const selector = () =>
      createElement(ChatSelector, {
        directory,
        chat: "",
        onSelect: vi.fn(),
        stateLabel: "Notification selection",
        badge: () => "Selected destination",
        actions: () =>
          createElement(Check, {
            label: "Select destination 42",
            checked: true,
            onChange: vi.fn(),
          }),
      })
    const html = renderToStaticMarkup(createElement("div", null, selector(), selector()))
    expect(html).toContain("Notification selection")
    expect(html).not.toContain("Access / status")
    expect(html).toContain('role="checkbox"')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain("&lt;unsafe&gt;")
    const descriptions = [...html.matchAll(/aria-describedby="([^"]+)"/g)].map((match) => match[1])
    expect(descriptions).toHaveLength(2)
    expect(new Set(descriptions).size).toBe(2)
    for (const id of descriptions) expect(html).toContain(`id="${id}"`)
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
