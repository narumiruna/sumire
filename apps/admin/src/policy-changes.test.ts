import { describe, expect, it } from "vitest"
import { initialPolicy } from "../../bot/src/admin/policy.js"
import { policyChanges } from "./policy-changes.js"

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
