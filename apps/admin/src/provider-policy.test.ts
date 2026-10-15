import { describe, expect, it } from "vitest"
import type { Policy } from "./api.js"
import { loginUrl, withProviderModel } from "./provider-policy.js"

const policy: Policy = {
  tools: ["bash"],
  servers: ["fixture"],
  models: ["old/model"],
  defaults: {
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
      tools: [],
      servers: null,
      models: ["old/model"],
      model: "old/model",
      thinking: "off",
    },
  },
  providers: [],
}

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
