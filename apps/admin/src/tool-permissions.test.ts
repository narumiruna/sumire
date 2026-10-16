import {
  effectivePolicy,
  inherited,
  initialPolicy,
  validateReferences,
} from "@narumitw/sumire-policy"
import { describe, expect, it } from "vitest"
import type { Inventory } from "./api.js"
import {
  defaultPermissionSummary,
  permissionNames,
  toolPermissionGroups,
} from "./tool-permissions.js"

const server = {
  name: "fixture",
  tools: ["mcp__fixture__new"],
  connection: "not tested",
  env: {},
  headers: {},
}
const inventory: Inventory = {
  tools: ["read"],
  builtInTools: ["read"],
  providers: [],
  mcp: [server],
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
  it("groups inventory tools by server and leaves built-in and unknown names visible", () => {
    const other = {
      ...inventory,
      mcp: [
        ...inventory.mcp,
        { ...server, name: "other", tools: ["other-tool", "mcp__fixture__new"] },
        { ...server, name: "empty", tools: [] },
      ],
    }
    const names = ["read", "mcp__fixture__new", "manual", "other-tool"]
    expect(toolPermissionGroups(names, other)).toEqual([
      { id: "built-in", label: "Built-in tools", names: ["read"] },
      { id: "mcp:fixture", label: "MCP: fixture", names: ["mcp__fixture__new"] },
      { id: "mcp:other", label: "MCP: other", names: ["mcp__fixture__new", "other-tool"] },
      { id: "unknown", label: "Unknown source", names: ["manual"] },
    ])
    expect(toolPermissionGroups([], other)).toEqual([])
    expect(names).toEqual(["read", "mcp__fixture__new", "manual", "other-tool"])
  })
  it("does not infer source from tool prefixes or a legacy combined inventory", () => {
    expect(
      toolPermissionGroups(["mcp__missing__read", "read"], {
        ...inventory,
        builtInTools: undefined,
        mcp: [],
      }),
    ).toEqual([{ id: "unknown", label: "Unknown source", names: ["mcp__missing__read", "read"] }])
    expect(
      toolPermissionGroups(["read"], {
        ...inventory,
        mcp: [{ ...server, tools: ["read"] }],
      }),
    ).toEqual([
      { id: "built-in", label: "Built-in tools", names: ["read"] },
      { id: "mcp:fixture", label: "MCP: fixture", names: ["read"] },
    ])
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
