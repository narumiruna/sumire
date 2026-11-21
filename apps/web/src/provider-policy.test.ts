import { effectivePolicy, inherited, validateReferences } from "@narumitw/sumire-policy"
import { describe, expect, it } from "vitest"
import type { Inventory, Policy } from "./api.js"
import {
  configuredProviders,
  loginUrl,
  modelRemovalImpact,
  providerReferences,
  savedProviderSelection,
  withModelAvailability,
  withProviderModel,
} from "./provider-policy.js"

const policy: Policy = {
  githubNotifications: { allowedUsernames: [] },
  skills: [],
  tools: ["bash"],
  servers: ["fixture"],
  models: ["old/model"],
  defaults: {
    skills: [],
    tools: ["bash"],
    servers: [],
    models: ["old/model"],
    model: "old/model",
    thinking: "off",
  },
  privateUsers: [42],
  groups: [-42],
  chats: {
    "42": {
      enabled: true,
      skills: null,
      tools: [],
      servers: null,
      models: ["old/model"],
      model: "old/model",
      thinking: "off",
    },
  },
  providers: [],
}

describe("saved provider selection", () => {
  it("loads the bot default and thinking level, preserving slashes in model IDs", () => {
    expect(
      savedProviderSelection({
        ...policy,
        defaults: { ...policy.defaults, model: "vendor/family/model", thinking: "high" },
      }),
    ).toEqual({ provider: "vendor", model: "family/model", thinking: "high" })
  })
  it("loads a unique existing chat model without promoting it to a shared default", () => {
    const legacy = { ...policy, defaults: { ...policy.defaults, model: null } }
    expect(savedProviderSelection(legacy)).toEqual({
      provider: "old",
      model: "model",
      thinking: "off",
    })
    expect(legacy.defaults.model).toBeNull()
  })
  it("does not choose a model when chats use different models", () => {
    const selection = savedProviderSelection({
      ...policy,
      defaults: { ...policy.defaults, model: null },
      chats: { ...policy.chats, "43": { ...policy.defaults, enabled: true, model: "old/other" } },
    })
    expect(selection).toEqual({ provider: "old", model: "", thinking: "off" })
  })
  it("does not choose a provider when chat providers differ", () => {
    expect(
      savedProviderSelection({
        ...policy,
        defaults: { ...policy.defaults, model: null },
        chats: {
          ...policy.chats,
          "43": { ...policy.defaults, enabled: true, model: "other/model" },
        },
      }).provider,
    ).toBe("")
  })
  it("requires a thinking choice when existing chats use different levels", () => {
    expect(
      savedProviderSelection({
        ...policy,
        defaults: { ...policy.defaults, model: null },
        chats: { ...policy.chats, "43": { ...policy.defaults, enabled: true, thinking: "low" } },
      }).thinking,
    ).toBeNull()
  })
  it("does not invent a model when no saved selection exists", () => {
    expect(
      savedProviderSelection({
        ...policy,
        defaults: { ...policy.defaults, model: null },
        chats: {},
      }),
    ).toEqual({ provider: "", model: "", thinking: null })
  })
})

describe("provider selection policy", () => {
  it("adds only the selected model and keeps all other policy unchanged", () => {
    const result = withProviderModel(policy, "new/vendor/model")
    expect(result).toEqual({ ...policy, models: ["old/model", "new/vendor/model"] })
    expect(policy.models).toEqual(["old/model"])
  })
  it("never changes defaults or explicit chat overrides and is idempotent", () => {
    const result = withProviderModel(policy, "new/model")
    expect(result.defaults).toEqual(policy.defaults)
    expect(result.chats).toEqual(policy.chats)
    expect(result.privateUsers).toEqual([42])
    expect(withProviderModel(result, "new/model")).toEqual(result)
  })
})
describe("model availability policy", () => {
  it("clears removed default and chat selections without changing unrelated settings", () => {
    const before = structuredClone(policy)
    before.models.push("new/model")
    before.defaults.thinking = "high"
    before.chats["42"] = {
      ...inherited,
      ...before.chats["42"],
      enabled: false,
      models: ["old/model", "new/model"],
      thinking: "low",
    }
    before.chats["43"] = { ...inherited, enabled: true, thinking: "medium" }
    before.chats["44"] = { ...inherited, enabled: true, models: [], thinking: "off" }
    before.chats["45"] = {
      ...inherited,
      enabled: false,
      models: ["new/model"],
      model: "new/model",
      thinking: "high",
    }
    const original = structuredClone(before)
    const result = withModelAvailability(before, ["new/model"])
    expect(result).toEqual({
      ...before,
      models: ["new/model"],
      defaults: { ...before.defaults, models: [], model: null, thinking: null },
      chats: {
        ...before.chats,
        "42": { ...before.chats["42"], models: ["new/model"], model: null, thinking: null },
      },
    })
    expect(() => validateReferences(result)).not.toThrow()
    expect(effectivePolicy(result, 43).model).toBeNull()
    expect(before).toEqual(original)
    expect(withModelAvailability(result, ["new/model"])).toEqual(result)
  })

  it("preserves a surviving shared default and lets a cleared chat override inherit it", () => {
    const before: Policy = {
      ...policy,
      models: ["old/model", "new/model"],
      defaults: { ...policy.defaults, models: ["old/model", "new/model"], model: "new/model" },
      chats: {
        "42": {
          ...inherited,
          enabled: true,
          ...policy.chats["42"],
          models: null,
          thinking: "high",
        },
      },
    }
    const result = withModelAvailability(before, ["new/model"])
    expect(result.defaults).toEqual({ ...before.defaults, models: ["new/model"] })
    expect(result.chats["42"]).toEqual({
      ...before.chats["42"],
      models: null,
      model: null,
      thinking: null,
    })
    expect(effectivePolicy(result, 42)).toMatchObject({ model: "new/model", thinking: "off" })
    expect(() => validateReferences(result)).not.toThrow()
  })

  it("removes multiple models while preserving null and empty selections", () => {
    const before: Policy = {
      ...policy,
      models: ["old/model", "new/model"],
      defaults: { ...policy.defaults, models: null, model: null, thinking: "high" },
      chats: {
        "42": { ...inherited, enabled: true, models: [], thinking: "off" },
        "43": { ...inherited, enabled: true, models: ["old/model", "new/model"] },
      },
    }
    const result = withModelAvailability(before, [])
    expect(result.defaults).toEqual(before.defaults)
    expect(result.chats["42"]).toEqual(before.chats["42"])
    expect(result.chats["43"]).toEqual({ ...before.chats["43"], models: [] })
    expect(() => validateReferences(result)).not.toThrow()
  })

  it("does not expand default or chat selections when models are added or restored", () => {
    expect(withModelAvailability(policy, ["old/model", "new/model"])).toEqual({
      ...policy,
      models: ["old/model", "new/model"],
    })
    const removed = withModelAvailability(policy, [])
    const restored = withModelAvailability(removed, ["old/model"])
    expect(restored).toEqual({ ...removed, models: ["old/model"] })
    expect(restored.defaults.model).toBeNull()
    expect(restored.defaults.models).toEqual([])
  })

  it("retains unrelated invalid drafts for validation instead of silently repairing them", () => {
    const before: Policy = {
      ...policy,
      defaults: {
        ...policy.defaults,
        models: ["old/model", "missing/model"],
        model: "missing/model",
      },
    }
    const result = withModelAvailability(before, [])
    expect(result.defaults).toEqual({ ...before.defaults, models: ["missing/model"] })
    expect(() => validateReferences(result)).toThrow("missing/model")
  })
})

describe("complete model removal impact", () => {
  it("uses exactly the submitted transform and includes disabled/off-page and inherited entries", () => {
    const before: Policy = {
      ...policy,
      models: ["old/model", "new/model"],
      defaults: { ...policy.defaults, models: ["old/model", "new/model"], model: "new/model" },
      chats: {
        "999999": {
          ...inherited,
          enabled: false,
          models: ["old/model", "new/model"],
          model: "old/model",
          thinking: "high",
        },
        "43": { ...inherited, enabled: true },
        "44": { ...inherited, enabled: true, models: [] },
      },
    }
    const original = structuredClone(before)
    const impact = modelRemovalImpact(before, ["new/model"])
    expect(impact.after).toEqual(withModelAvailability(before, ["new/model"]))
    expect(impact.removed).toEqual(["old/model"])
    expect(impact.shared).toMatchObject({
      before: { models: ["old/model", "new/model"], model: "new/model", thinking: "off" },
      after: { models: ["new/model"], model: "new/model", thinking: "off" },
    })
    expect(impact.chats.map((entry) => entry.id)).toEqual(["43", "999999"])
    expect(impact.chats[0]).toMatchObject({
      before: { models: null, model: null, thinking: null },
      after: { models: null, model: null, thinking: null },
      effectiveAfter: { models: ["new/model"], model: "new/model", thinking: "off" },
    })
    expect(impact.chats[1]).toMatchObject({
      enabled: false,
      before: { models: ["old/model", "new/model"], model: "old/model", thinking: "high" },
      after: { models: ["new/model"], model: null, thinking: null },
      effectiveBefore: { model: "old/model", thinking: "high" },
      effectiveAfter: { model: "new/model", thinking: "off" },
    })
    expect(before).toEqual(original)
  })

  it("reports an absent effective model, shared reset, null and empty lists without inventing restoration", () => {
    const before: Policy = {
      ...policy,
      chats: {
        "42": { ...inherited, enabled: false, models: [], thinking: "low" },
        "43": { ...inherited, enabled: true },
      },
    }
    const impact = modelRemovalImpact(before, [])
    expect(impact.sharedChanged).toBe(true)
    expect(impact.shared.after).toEqual({ models: [], model: null, thinking: null })
    expect(impact.shared.effectiveAfter).toEqual({ models: [], model: null, thinking: "off" })
    expect(impact.chats.find((entry) => entry.id === "42")).toBeUndefined()
    expect(impact.after.chats["42"]).toEqual(before.chats["42"])
    expect(effectivePolicy(impact.after, 42)).toMatchObject({ model: null, thinking: "low" })
    expect(impact.chats.find((entry) => entry.id === "43")).toMatchObject({
      after: { models: null, model: null, thinking: null },
      effectiveAfter: { model: null, thinking: "off" },
    })
    const restored = withModelAvailability(impact.after, before.models)
    const restoredImpact = modelRemovalImpact(before, restored)
    expect(restoredImpact.removed).toEqual([])
    expect(restoredImpact.sharedChanged).toBe(true)
    expect(restoredImpact.shared.after.model).toBeNull()
    expect(restoredImpact.shared.after.models).toEqual([])
    expect(restoredImpact.after).toEqual(restored)
  })

  it("compares the actual cumulative staged policy and does not substitute a fresh transform", () => {
    const before = { ...policy, models: ["old/model", "other/model"] }
    const after = withModelAvailability(withModelAvailability(before, ["other/model"]), [])
    expect(modelRemovalImpact(before, after).after).toBe(after)
    expect(modelRemovalImpact(before, after).removed).toEqual(["old/model", "other/model"])
    expect(modelRemovalImpact(before, before).chats).toEqual([])
    expect(modelRemovalImpact(before, before).sharedChanged).toBe(false)
  })
})

describe("provider list and references", () => {
  const inventory: Inventory = {
    tools: [],
    mcp: [],
    providers: [
      {
        id: "configured",
        name: "Configured",
        configured: true,
        apiKey: true,
        oauth: false,
        models: [],
      },
      {
        id: "catalog",
        name: "Catalog only",
        configured: false,
        apiKey: true,
        oauth: false,
        models: [],
      },
      { id: "old", name: "Old", configured: false, apiKey: true, oauth: false, models: [] },
    ],
  }
  it("lists configured and all policy reference sources, not the unconfigured catalog", () => {
    const before: Policy = {
      ...policy,
      providers: [{ id: "endpoint", enabled: false, models: [] }],
      defaults: { ...policy.defaults, models: ["allowed/model"], model: "default/model" },
      chats: {
        "42": { ...inherited, enabled: false, models: ["offpage/list"], model: "offpage/chosen" },
      },
    }
    const result = configuredProviders(before, inventory)
    expect(result.map((entry) => entry.id)).toEqual([
      "allowed",
      "configured",
      "default",
      "endpoint",
      "offpage",
      "old",
    ])
    expect(result.find((entry) => entry.id === "offpage")).toMatchObject({
      name: "offpage",
      configured: null,
    })
    expect(result.find((entry) => entry.id === "old")?.configured).toBe(false)
    expect(
      configuredProviders(
        { ...before, models: [], providers: [], defaults: inherited, chats: {} },
        { providers: [], tools: [], mcp: [] },
      ),
    ).toEqual([])
  })
  it("counts explicit policy entries including disabled references only once; no inheriting population", () => {
    const before: Policy = {
      ...policy,
      chats: {
        ...policy.chats,
        "43": {
          ...inherited,
          enabled: false,
          models: ["old/model", "old/other"],
          model: "old/model",
        },
        "44": { ...inherited, enabled: true },
        "45": { ...inherited, enabled: true, model: "oldish/model" },
      },
    }
    expect(providerReferences(before, "old")).toMatchObject({
      available: ["old/model"],
      sharedModel: "old/model",
      sharedAllowed: ["old/model"],
      chats: [{ id: "42" }, { id: "43", enabled: false }],
    })
    expect(providerReferences(before, "catalog").chats).toEqual([])
    expect(before.chats["44"]?.model).toBeNull()
  })
})

describe("provider sign-in links", () => {
  it("allows HTTP(S) links but rejects executable schemes and credentials", () => {
    expect(loginUrl("https://example.test/login?state=fixture")).toBe(
      "https://example.test/login?state=fixture",
    )
    for (const value of [
      undefined,
      "",
      "invalid",
      "javascript:alert(1)",
      "data:text/html,fixture",
      "https://user:secret@example.test",
    ])
      expect(loginUrl(value)).toBeUndefined()
  })
})
