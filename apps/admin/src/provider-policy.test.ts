import { describe, expect, it } from "vitest"
import type { Policy } from "./api.js"
import { loginUrl, savedProviderSelection, withProviderModel } from "./provider-policy.js"

const policy: Policy = {
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
    const result = withProviderModel(policy, "new/vendor/model", "high", false)
    expect(result).toEqual({ ...policy, models: ["old/model", "new/vendor/model"] })
    expect(policy.models).toEqual(["old/model"])
  })
  it("sets the default only on request and preserves explicit chat overrides", () => {
    const result = withProviderModel(policy, "new/model", "low", true)
    expect(result.defaults).toEqual({
      ...policy.defaults,
      models: ["old/model", "new/model"],
      model: "new/model",
      thinking: "low",
    })
    expect(result.chats).toEqual(policy.chats)
    expect(result.privateUsers).toEqual([42])
    expect(withProviderModel(result, "new/model", "low", true)).toEqual(result)
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
