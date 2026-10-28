import { describe, expect, expectTypeOf, it } from "vitest"
import type { z } from "zod"
import {
  effectivePolicy,
  inherited,
  initialPolicy,
  POLICY_MAX_NAMES,
  policySchema,
  selectionSchema,
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
    expect(policy.skills).toEqual([])
    expect(policy.defaults.skills).toEqual([])
    policy.skills.push("review")
    policy.defaults.skills?.push("review")
    expect(initialPolicy().skills).toEqual([])
    expect(initialPolicy().defaults.skills).toEqual([])
    expect(inherited.skills).toBeNull()
    expect(policy.githubNotifications).toEqual({ allowedUsernames: [] })
    policy.githubNotifications.allowedUsernames.push("octocat")
    expect(initialPolicy().githubNotifications.allowedUsernames).toEqual([])
  })

  it("parses old policies and literal selections with safe skills defaults", () => {
    const oldSelection = {
      tools: null,
      servers: null,
      models: null,
      model: null,
      thinking: null,
    } satisfies z.input<typeof selectionSchema>
    expect(selectionSchema.parse(oldSelection)).toEqual(inherited)
    expectTypeOf<z.output<typeof selectionSchema>["skills"]>().toEqualTypeOf<string[] | null>()
    const oldPolicy = {
      tools: [],
      servers: [],
      models: [],
      defaults: oldSelection,
      privateUsers: [42],
      groups: [],
      chats: { "42": { ...oldSelection, enabled: true } },
      providers: [],
    } satisfies z.input<typeof policySchema>
    const parsed = policySchema.parse(oldPolicy)
    expect(parsed.skills).toEqual([])
    expect(parsed.githubNotifications).toEqual({ allowedUsernames: [] })
    parsed.githubNotifications.allowedUsernames.push("octocat")
    expect(policySchema.parse(oldPolicy).githubNotifications.allowedUsernames).toEqual([])
    expect(parsed.defaults.skills).toBeNull()
    expect(parsed.chats["42"]?.skills).toBeNull()
    expect(effectivePolicy(parsed, 42).skills).toEqual([])
    expect(() => validateReferences(parsed)).not.toThrow()
  })

  it("validates and normalizes GitHub mention authors without accepting legacy Telegram IDs", () => {
    for (const githubNotifications of [
      null,
      [],
      {},
      { allowedUserIds: [] },
      { allowedUserIds: [42] },
      { allowedUsernames: [], allowedUserIds: [] },
      { allowedUsernames: null },
      { allowedUsernames: "octocat" },
      { allowedUsernames: [42] },
      ...[
        "",
        "-cat",
        "cat-",
        "two--hyphens",
        "@cat",
        "cat.name",
        "cat_name",
        " cat",
        "cat ",
        "cat\n",
        "cat\r\n",
        "cat\u2028",
        "cat\u0000",
        "猫",
        "a".repeat(40),
      ].map((username) => ({ allowedUsernames: [username] })),
      { allowedUsernames: ["octocat", "OCTOCAT"] },
      { allowedUsernames: ["octocat", "octocat"] },
      { allowedUsernames: [], extra: true },
      { allowedUsernames: Array.from({ length: 1001 }, (_, i) => `user-${i}`) },
    ]) {
      expect(policySchema.safeParse({ ...initialPolicy(), githubNotifications }).success).toBe(
        false,
      )
    }
    const allowedUsernames = Array.from({ length: 1000 }, (_, i) => `user-${i}`)
    expect(
      policySchema.parse({ ...initialPolicy(), githubNotifications: { allowedUsernames } })
        .githubNotifications.allowedUsernames,
    ).toEqual(allowedUsernames)
    expect(
      policySchema.parse({
        ...initialPolicy(),
        githubNotifications: { allowedUsernames: ["OctoCat", "A-1", "9", "a".repeat(39)] },
      }).githubNotifications.allowedUsernames,
    ).toEqual(["octocat", "a-1", "9", "a".repeat(39)])
  })

  it("intersects skills with global availability and distinguishes inheritance from empty", () => {
    const policy = initialPolicy()
    policy.skills = ["review", "release"]
    policy.defaults.skills = ["review"]
    policy.chats["42"] = { ...inherited, enabled: true }
    expect(effectivePolicy(policy, 42)).toMatchObject({
      skills: ["review"],
      sources: { skills: "default" },
    })
    policy.chats["42"].skills = []
    expect(effectivePolicy(policy, 42)).toMatchObject({
      skills: [],
      sources: { skills: "chat" },
    })
    policy.chats["42"].skills = ["release", "unknown"]
    expect(effectivePolicy(policy, 42).skills).toEqual(["release"])
    expect(() => validateReferences(policy)).toThrow(
      "Chats → 42: skills selection exceeds global availability: unknown",
    )
    policy.chats["42"].skills = null
    policy.defaults.skills = ["unknown"]
    expect(effectivePolicy(policy, 42).skills).toEqual([])
    expect(() => validateReferences(policy)).toThrow(
      "Defaults: skills selection exceeds global availability: unknown",
    )
    policy.defaults.skills = null
    expect(effectivePolicy(policy, 42).skills).toEqual([])
    expect(() => validateReferences(policy)).not.toThrow()
  })

  it("validates skill names, duplicates, and list capacity", () => {
    for (const skills of [
      [""],
      ["x".repeat(257)],
      ["review", "review"],
      Array.from({ length: POLICY_MAX_NAMES + 1 }, (_, i) => `skill-${i}`),
    ]) {
      expect(policySchema.safeParse({ ...initialPolicy(), skills }).success).toBe(false)
      expect(selectionSchema.safeParse({ ...inherited, skills }).success).toBe(false)
    }
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
    expect(() => validateReferences(policy)).toThrow("default model in Shared defaults")
  })
})
