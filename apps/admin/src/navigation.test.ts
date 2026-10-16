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
  it("accepts supported sections and exact, non-zero chat IDs", () => {
    expect(
      readNavigation(new URL("https://example.com/?section=Model%20Providers&chat=-100")),
    ).toEqual({ page: "Model Providers", chat: "-100" })
  })
  it("creates compatible same-path section links while retaining other URL state", () => {
    expect(navigationHref("Tools / MCP", "42", new URL("https://example.com/?existing=1"))).toBe(
      "/?existing=1&section=Tools+%2F+MCP&chat=42",
    )
    expect(navigationHref("Chats", "", new URL("https://example.com/?chat=42"))).toBe(
      "/?section=Chats",
    )
  })
})
