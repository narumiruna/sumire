import { inherited, initialPolicy, type Policy } from "@narumitw/sumire-policy"
import { describe, expect, it } from "vitest"
import { recoverPolicy } from "./policy-recovery.js"

function policies() {
  const base = initialPolicy()
  return { base, draft: structuredClone(base), latest: structuredClone(base) }
}

describe("policy recovery", () => {
  it("keeps concurrent values outside local edits", () => {
    const { base, draft, latest } = policies()
    draft.defaults.thinking = "high"
    latest.privateUsers = [42]
    latest.chats["42"] = { ...inherited, enabled: false }
    const result = recoverPolicy(base, draft, latest)
    expect(result.policy.privateUsers).toEqual([42])
    expect(result.policy.chats["42"]?.enabled).toBe(false)
    expect(result.policy.defaults.thinking).toBe("high")
    expect(result.unresolved).toBe(0)
    expect(result.changes.map((change) => change.id)).toEqual(["defaults.thinking"])
  })

  it("requires an explicit choice for overlapping changes", () => {
    const { base, draft, latest } = policies()
    draft.defaults.thinking = "high"
    latest.defaults.thinking = "low"
    const unresolved = recoverPolicy(base, draft, latest)
    expect(unresolved.unresolved).toBe(1)
    expect(unresolved.policy.defaults.thinking).toBe("low")
    expect(unresolved.changes[0]?.state).toBe("conflict")
    expect(
      recoverPolicy(base, draft, latest, { "defaults.thinking": "draft" }).policy.defaults.thinking,
    ).toBe("high")
    expect(
      recoverPolicy(base, draft, latest, { "defaults.thinking": "saved" }).policy.defaults.thinking,
    ).toBe("low")
  })

  it.each(["tools", "skills", "servers", "models", "privateUsers", "groups"] as const)(
    "treats %s as an atomic list without combining members",
    (key) => {
      const { base, draft, latest } = policies()
      Object.assign(draft, {
        [key]: [key === "privateUsers" ? 42 : key === "groups" ? -42 : "local"],
      })
      Object.assign(latest, {
        [key]: [key === "privateUsers" ? 43 : key === "groups" ? -43 : "saved"],
      })
      expect(recoverPolicy(base, draft, latest).unresolved).toBe(1)
      const result = recoverPolicy(base, draft, latest, { [key]: "draft" })
      expect(result.unresolved).toBe(0)
      expect(result.policy[key]).toEqual(draft[key])
    },
  )

  it("preserves provider order and treats provider configuration as one value", () => {
    const { base, draft, latest } = policies()
    base.providers = [
      { id: "a", enabled: true, models: [] },
      { id: "b", enabled: true, models: [] },
    ]
    draft.providers = structuredClone([...base.providers].reverse())
    latest.providers = structuredClone(base.providers)
    latest.providers[0] = { id: "a", enabled: false, models: [] }
    const result = recoverPolicy(base, draft, latest)
    expect(result.unresolved).toBe(1)
    expect(result.policy.providers).toEqual(latest.providers)
    expect(recoverPolicy(base, draft, latest, { providers: "draft" }).policy.providers).toEqual(
      draft.providers,
    )
  })

  it("keeps deletion, inheritance, and explicit empty overrides distinct", () => {
    const { base, draft, latest } = policies()
    base.chats["42"] = { ...inherited, enabled: true }
    draft.chats["42"] = { ...inherited, tools: [], enabled: true }
    const conflict = recoverPolicy(base, draft, latest)
    expect(conflict.unresolved).toBe(1)
    expect(conflict.policy.chats["42"]).toBeUndefined()
    expect(
      recoverPolicy(base, draft, latest, { "chats.42": "draft" }).policy.chats["42"]?.tools,
    ).toEqual([])
    expect(
      recoverPolicy(base, draft, latest, { "chats.42": "saved" }).policy.chats["42"],
    ).toBeUndefined()
    draft.defaults.tools = null
    const result = recoverPolicy(base, draft, latest, { "chats.42": "saved" })
    expect(result.policy.defaults.tools).toBeNull()
  })

  it("handles local record additions and removals without dropping remote records", () => {
    const { base, draft, latest } = policies()
    base.chats["42"] = { ...inherited, enabled: true }
    latest.chats["42"] = { ...inherited, enabled: true }
    latest.chats["43"] = { ...inherited, enabled: false }
    draft.chats["44"] = { ...inherited, enabled: true }
    const result = recoverPolicy(base, draft, latest)
    expect(result.unresolved).toBe(0)
    expect(result.policy.chats["42"]).toBeUndefined()
    expect(result.policy.chats["43"]?.enabled).toBe(false)
    expect(result.policy.chats["44"]?.enabled).toBe(true)
  })

  it("recognizes identical drafts as already saved, independent of object key order", () => {
    const { base, draft, latest } = policies()
    draft.chats["42"] = { ...inherited, enabled: true }
    latest.chats["42"] = { enabled: true, ...inherited }
    const result = recoverPolicy(base, draft, latest)
    expect(result.unresolved).toBe(0)
    expect(result.policy).toEqual(latest)
    expect(result.changes[0]?.state).toBe("saved")
  })

  it("requires a choice for edits that undo an unconfirmed submitted change", () => {
    const { base, draft, latest } = policies()
    const submitted = structuredClone(base)
    submitted.privateUsers = [42]
    submitted.defaults.thinking = "high"
    submitted.chats["42"] = { ...inherited, enabled: true }
    Object.assign(latest, structuredClone(submitted))
    const result = recoverPolicy(base, draft, latest, {}, submitted)
    expect(result.unresolved).toBe(3)
    expect(result.changes.map((change) => change.id)).toEqual([
      "privateUsers",
      "defaults.thinking",
      "chats.42",
    ])
    const restored = recoverPolicy(
      base,
      draft,
      latest,
      { privateUsers: "draft", "defaults.thinking": "draft", "chats.42": "draft" },
      submitted,
    )
    expect(restored.unresolved).toBe(0)
    expect(restored.policy).toEqual(base)
  })

  it("does not let a supplied choice alter a field that was not edited locally", () => {
    const { base, draft, latest } = policies()
    latest.defaults.thinking = "high"
    const result = recoverPolicy(base, draft, latest, { "defaults.thinking": "draft" })
    expect(result.changes).toEqual([])
    expect(result.policy.defaults.thinking).toBe("high")
  })

  it("does not mutate or alias any input policy or change value", () => {
    const { base, draft, latest } = policies()
    draft.privateUsers = [42]
    const originals = [base, draft, latest].map((policy) => structuredClone(policy))
    const result = recoverPolicy(base, draft, latest)
    result.policy.privateUsers.push(43)
    const retainedValue = result.changes[0]?.draft
    if (!Array.isArray(retainedValue)) throw new Error("Missing retained list")
    retainedValue.push(44)
    expect([base, draft, latest]).toEqual(originals)
  })

  it("is deterministic for all supported recovery units", () => {
    const { base, draft, latest } = policies()
    draft.defaults = {
      tools: [],
      skills: [],
      servers: [],
      models: [],
      model: "fixture/model",
      thinking: "high",
    }
    const first = recoverPolicy(base, draft, latest)
    expect(first).toEqual(recoverPolicy(base, draft, latest))
    expect(first.changes.map((change) => change.id)).toEqual([
      "defaults.model",
      "defaults.thinking",
    ])
    const copy: Policy = first.policy
    expect(copy.defaults.model).toBe("fixture/model")
  })
})
