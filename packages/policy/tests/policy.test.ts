import { describe, expect, it } from "vitest"
import {
  effectivePolicy,
  inherited,
  initialPolicy,
  policySchema,
  validateReferences,
} from "../src/index.js"

describe("shared policy", () => {
  it("starts with a valid deny-all policy and independent defaults", () => {
    const policy = initialPolicy()
    expect(policySchema.parse(policy)).toEqual(policy)
    expect(effectivePolicy(policy, 42).enabled).toBe(false)
    expect(effectivePolicy(policy, -100).enabled).toBe(false)
    policy.defaults.tools?.push("read")
    expect(initialPolicy().defaults.tools).toEqual([])
    expect(inherited.tools).toBeNull()
  })

  it("preserves inheritance, explicit empty lists, global ceilings, and sources", () => {
    const policy = initialPolicy()
    policy.privateUsers = [42]
    policy.tools = ["read"]
    policy.defaults.tools = ["read"]
    expect(effectivePolicy(policy, 42)).toMatchObject({
      enabled: true,
      tools: ["read"],
      sources: { tools: "default" },
    })
    policy.chats["42"] = { ...inherited, enabled: true, tools: [] }
    expect(effectivePolicy(policy, 42)).toMatchObject({ tools: [], sources: { tools: "chat" } })
    policy.chats["42"].tools = ["bash"]
    expect(effectivePolicy(policy, 42).tools).toEqual([])
    expect(() => validateReferences(policy)).toThrow("global availability")
  })

  it("requires access grants and honors disabled chat overrides", () => {
    const policy = initialPolicy()
    policy.chats["42"] = { ...inherited, enabled: true }
    expect(effectivePolicy(policy, 42).enabled).toBe(false)
    policy.groups = [-100]
    expect(effectivePolicy(policy, -100).enabled).toBe(true)
    policy.chats["-100"] = { ...inherited, enabled: false }
    expect(effectivePolicy(policy, -100).enabled).toBe(false)
  })

  it("filters disabled providers and rejects referenced disabled providers", () => {
    const policy = initialPolicy()
    policy.models = ["fixture/model"]
    policy.defaults.models = ["fixture/model"]
    policy.defaults.model = "fixture/model"
    policy.providers = [{ id: "fixture", enabled: false, models: [] }]
    expect(effectivePolicy(policy, 42)).toMatchObject({ models: [], model: null })
    expect(() => validateReferences(policy)).toThrow("Provider is still referenced")
  })

  it("retains strict schema validation and model reference checks", () => {
    expect(policySchema.safeParse({ ...initialPolicy(), secret: "invalid" }).success).toBe(false)
    expect(policySchema.safeParse({ ...initialPolicy(), privateUsers: [-1] }).success).toBe(false)
    expect(policySchema.safeParse({ ...initialPolicy(), tools: ["read", "read"] }).success).toBe(
      false,
    )
    const policy = initialPolicy()
    policy.defaults.model = "fixture/unknown"
    expect(() => validateReferences(policy)).toThrow("Allowed models")
  })
})
