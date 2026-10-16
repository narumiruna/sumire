import { describe, expect, it } from "vitest"
import {
  effectivePolicy,
  inherited,
  initialPolicy,
  validateReferences,
} from "../../bot/src/admin/policy.js"
import type { Inventory } from "./api.js"
import { defaultPermissionSummary, permissionNames } from "./tool-permissions.js"

const inventory: Inventory = {
  tools: ["read"],
  providers: [],
  mcp: [
    {
      name: "fixture",
      tools: ["mcp__fixture__new"],
      connection: "not tested",
      env: {},
      headers: {},
    },
  ],
}

describe("tool permission presentation and existing policy rules", () => {
  it("keeps saved, undiscovered, default, and explicit override names visible without granting discovery results", () => {
    const saved = initialPolicy()
    saved.tools = ["manual"]
    const draft = structuredClone(saved)
    draft.tools = []
    draft.defaults.tools = ["stored"]
    draft.chats["42"] = { ...inherited, enabled: true, tools: ["override"], servers: ["offline"] }
    const before = structuredClone(draft)
    expect(permissionNames("tools", draft, saved, inventory)).toEqual([
      "read",
      "mcp__fixture__new",
      "manual",
      "stored",
      "override",
    ])
    expect(permissionNames("servers", draft, saved, inventory)).toEqual(["fixture", "offline"])
    expect(draft).toEqual(before)
    expect(effectivePolicy(draft, 42).tools).toEqual([])
  })
  it("counts only inherited default selections within the global ceiling", () => {
    const policy = initialPolicy()
    policy.tools = ["read", "bash"]
    policy.defaults.tools = ["read", "blocked"]
    policy.servers = ["fixture"]
    policy.defaults.servers = ["fixture", "offline"]
    expect(defaultPermissionSummary(policy)).toBe(
      "1 default tool names within global permission · 1 default MCP server gates within global permission",
    )
  })
  it("preserves explicit empty overrides and global restrictions; reference conflicts require explicit resolution", () => {
    const policy = initialPolicy()
    policy.tools = ["read"]
    policy.defaults.tools = ["read"]
    policy.chats["42"] = { ...inherited, enabled: true, tools: [] }
    policy.chats["43"] = { ...inherited, enabled: true, tools: ["read"] }
    expect(effectivePolicy(policy, 42).tools).toEqual([])
    policy.defaults.tools = []
    expect(effectivePolicy(policy, 43).tools).toEqual(["read"])
    policy.tools = []
    expect(effectivePolicy(policy, 43).tools).toEqual([])
    expect(policy.chats["43"].tools).toEqual(["read"])
    expect(() => validateReferences(policy)).toThrow(
      "Chats → 43: tools selection exceeds global availability",
    )
    policy.chats["43"].tools = []
    expect(() => validateReferences(policy)).not.toThrow()
  })
})
