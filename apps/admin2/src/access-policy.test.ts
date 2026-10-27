import { initialPolicy } from "@narumitw/sumire-policy"
import { describe, expect, it } from "vitest"
import { accessState, parseChatId, withChatAccess } from "./access-policy.js"

describe("chat access", () => {
  it("adds people and groups to their own lists once", () => {
    let policy = withChatAccess(initialPolicy(), 42, true)
    policy = withChatAccess(policy, 42, true)
    policy = withChatAccess(policy, -100, true)
    expect(policy.privateUsers).toEqual([42])
    expect(policy.groups).toEqual([-100])
  })
  it("revokes without touching the other list", () => {
    const policy = withChatAccess(withChatAccess(initialPolicy(), -100, true), 42, true)
    const next = withChatAccess(policy, 42, false)
    expect(next.privateUsers).toEqual([])
    expect(next.groups).toEqual([-100])
  })
  it("rejects zero and unsafe IDs", () => {
    expect(() => withChatAccess(initialPolicy(), 0, true)).toThrow()
    expect(parseChatId("0")).toBeUndefined()
    expect(parseChatId("12.5")).toBeUndefined()
    expect(parseChatId("99999999999999999999")).toBeUndefined()
    expect(parseChatId(" -1001234 ")).toBe(-1001234)
  })
  it("explains a chat override that disables an approved chat", () => {
    const policy = withChatAccess(initialPolicy(), 42, true)
    expect(accessState(policy, 42).label).toBe("Approved")
    policy.chats["42"] = {
      enabled: false,
      tools: null,
      skills: null,
      servers: null,
      models: null,
      model: null,
      thinking: null,
    }
    expect(accessState(policy, 42)).toEqual({ allowed: false, label: "Approved, chat disabled" })
    expect(accessState(policy, 7).label).toBe("Not approved")
  })
})
