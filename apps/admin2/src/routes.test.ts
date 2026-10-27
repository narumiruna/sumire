import { describe, expect, it } from "vitest"
import { href, parseRoute } from "./routes.js"

describe("routes", () => {
  it("opens chats at the v2 root and for unknown sections", () => {
    expect(parseRoute({ pathname: "/v2/", search: "" }).section).toBe("chats")
    expect(parseRoute({ pathname: "/v2", search: "" }).section).toBe("chats")
    expect(parseRoute({ pathname: "/v2/providers", search: "" }).section).toBe("chats")
  })
  it("reads the section and keeps filters in the URL", () => {
    const route = parseRoute({ pathname: "/v2/audit/", search: "?actor=42" })
    expect(route.section).toBe("audit")
    expect(route.params.get("actor")).toBe("42")
  })
  it("builds links under /v2/ without empty parameters", () => {
    expect(href("access")).toBe("/v2/access")
    expect(href("chats", { q: "team", offset: undefined, chat: "" })).toBe("/v2/chats?q=team")
  })
})
