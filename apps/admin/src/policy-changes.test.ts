import { initialPolicy } from "@narumitw/sumire-policy"
import { describe, expect, it } from "vitest"
import { policyChanges, withChatAccess } from "./policy-changes.js"

describe("policyChanges", () => {
  it("reports no changes for identical policies", () => {
    expect(policyChanges(initialPolicy(), initialPolicy())).toEqual([])
  })
  it("distinguishes approval, revocation, overrides, and global edits", () => {
    const saved = initialPolicy()
    saved.privateUsers = [42]
    const draft = structuredClone(saved)
    draft.privateUsers = [43]
    draft.groups = [-100]
    draft.chats["43"] = {
      tools: [],
      servers: null,
      models: null,
      model: null,
      thinking: null,
      enabled: false,
    }
    draft.tools = ["read"]
    expect(policyChanges(saved, draft)).toEqual([
      "Private-message access: approve 43",
      "Private-message access: revoke 42",
      "Group/channel access: approve -100",
      "Chat 43: overrides or enabled switch",
      "Global tool availability",
    ])
  })
  it("does not include provider endpoint values in the summary", () => {
    const saved = initialPolicy()
    const draft = structuredClone(saved)
    draft.providers = [{ id: "fixture", enabled: true, baseUrl: "https://example.com", models: [] }]
    expect(policyChanges(saved, draft)).toEqual(["Provider configuration"])
  })
})

describe("withChatAccess", () => {
  it("edits only the explicit ID scope without enabling a disabled chat", () => {
    const policy = initialPolicy()
    policy.privateUsers = [42]
    policy.chats["-100"] = {
      tools: [],
      servers: null,
      models: null,
      model: null,
      thinking: null,
      enabled: false,
    }
    const draft = withChatAccess(policy, -100, true)
    expect(draft.groups).toEqual([-100])
    expect(draft.privateUsers).toEqual([42])
    expect(draft.chats).toEqual(policy.chats)
    expect(policy.groups).toEqual([])
    expect(withChatAccess(draft, -100, true).groups).toEqual([-100])
  })
  it("supports grant, revocation, and undo without counting access-list order as a change", () => {
    const policy = initialPolicy()
    policy.privateUsers = [42, 43]
    const revoked = withChatAccess(policy, 42, false)
    expect(policyChanges(policy, revoked)).toEqual(["Private-message access: revoke 42"])
    expect(policyChanges(policy, withChatAccess(revoked, 42, true))).toEqual([])
  })
  it("rejects invalid IDs instead of editing another access scope", () => {
    for (const id of [0, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => withChatAccess(initialPolicy(), id, true)).toThrow("valid, non-zero Telegram ID")
    }
  })
})
