import { effectivePolicy, inherited, validateReferences } from "@narumitw/sumire-policy"
import { describe, expect, it } from "vitest"
import type { Policy } from "./api.js"
import {
  loginUrl,
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
