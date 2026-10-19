import { describe, expect, it } from "vitest"
import { navigationHref, readNavigation } from "./navigation.js"

describe("admin navigation", () => {
  it("defaults unknown sections and invalid chat IDs without changing policy", () => {
    expect(readNavigation(new URL("https://example.com/?section=Missing&chat=0"))).toEqual({
      page: "Chats",
      chat: "",
    })
    expect(
      readNavigation(new URL("https://example.com/?section=Access&chat=9007199254740992")),
    ).toEqual({ page: "Access", chat: "" })
    expect(readNavigation(new URL("https://example.com/?chat=42x"))).toEqual({
      page: "Chats",
      chat: "",
    })
  })
  it("rejects noncanonical chat IDs in deep links and navigation links", () => {
    for (const chat of ["0042", "-00100", "+42", "42.0"]) {
      const url = new URL("https://example.com/?section=Chats")
      url.searchParams.set("chat", chat)
      expect(readNavigation(url)).toEqual({ page: "Chats", chat: "" })
      expect(navigationHref("Chats", chat, url)).toBe("/?section=Chats")
    }
  })
  it("maps legacy Tools / MCP links to tool permissions", () => {
    expect(readNavigation(new URL("https://example.com/?section=Tools+%2F+MCP&chat=42"))).toEqual({
      page: "Tool permissions",
      chat: "42",
    })
    expect(readNavigation(new URL("https://example.com/?section=MCP+connections"))).toEqual({
      page: "MCP connections",
      chat: "",
    })
  })
  it("accepts the normalized provider label while retaining old links", () => {
    expect(readNavigation(new URL("https://example.com/?section=Model+providers"))).toEqual({
      page: "Model Providers",
      chat: "",
    })
  })
  it("accepts supported sections and exact, non-zero chat IDs", () => {
    expect(
      readNavigation(new URL("https://example.com/?section=Model%20Providers&chat=-100")),
    ).toEqual({ page: "Model Providers", chat: "-100" })
  })
  it("preserves chat-scoped Durable deep links but clears stale object context on chat or page changes", () => {
    const href =
      "https://example.com/?section=Durable&chat=-100&view=documents&scope=task&conversationId=7&taskId=8&objectId=9"
    expect(readNavigation(new URL(href))).toEqual({ page: "Durable", chat: "-100" })
    expect(navigationHref("Durable", "-100", new URL(href))).toContain("objectId=9")
    expect(navigationHref("Durable", "42", new URL(href))).toBe("/?section=Durable&chat=42")
    expect(navigationHref("Chats", "-100", new URL(href))).toBe("/?section=Chats&chat=-100")
  })
  it("preserves all same-chat inspector fields but clears every old-chat field on selection", () => {
    const source = new URL(
      "https://example.com/admin?section=Durable&chat=-9001&view=documents&scope=task&conversationId=7&taskId=8&objectId=9&existing=1#details",
    )
    const same = new URL(navigationHref("Durable", "-9001", new URL(source)), source)
    for (const key of ["view", "scope", "conversationId", "taskId", "objectId"])
      expect(same.searchParams.get(key)).toBe(source.searchParams.get(key))
    const changed = new URL(navigationHref("Durable", "-9002", new URL(source)), source)
    expect(readNavigation(changed)).toEqual({ page: "Durable", chat: "-9002" })
    for (const key of ["view", "scope", "conversationId", "taskId", "objectId"])
      expect(changed.searchParams.has(key)).toBe(false)
    expect(changed.pathname).toBe("/admin")
    expect(changed.searchParams.get("existing")).toBe("1")
    expect(changed.hash).toBe("#details")
  })
  it("accepts safe complete IDs at both numeric limits", () => {
    for (const chat of ["9007199254740991", "-9007199254740991"]) {
      const url = new URL(`https://example.com/admin?section=Durable&chat=${chat}`)
      expect(readNavigation(url)).toEqual({ page: "Durable", chat })
      expect(navigationHref("Chats", chat, url)).toBe(`/admin?section=Chats&chat=${chat}`)
    }
  })
  it("creates compatible same-path section links while retaining other URL state", () => {
    expect(
      navigationHref("Tool permissions", "42", new URL("https://example.com/?existing=1")),
    ).toBe("/?existing=1&section=Tool+permissions&chat=42")
    expect(navigationHref("Chats", "", new URL("https://example.com/?chat=42"))).toBe(
      "/?section=Chats",
    )
  })
})
