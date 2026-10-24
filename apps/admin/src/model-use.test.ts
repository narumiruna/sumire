import { inherited } from "@narumitw/sumire-policy"
import { describe, expect, it } from "vitest"
import type { Policy } from "./api.js"
import { stageModelUse } from "./model-use.js"

function policy(): Policy {
  return {
    tools: ["read"],
    servers: [],
    skills: [],
    models: ["p/old", "p/new"],
    providers: [],
    privateUsers: [42],
    groups: [],
    defaults: { ...inherited, model: "p/old", models: ["p/old"], thinking: "off" },
    chats: {
      "42": { ...inherited, enabled: false, tools: [] },
      "43": { ...inherited, enabled: true, model: "p/old" },
    },
  }
}
describe("model use staging", () => {
  it("changes only shared model fields and preserves explicit overrides", () => {
    const before = policy()
    const after = stageModelUse(before, "p/new", "off", "defaults", "42")
    expect(after).toEqual({
      ...before,
      defaults: { ...before.defaults, model: "p/new", thinking: "off", models: ["p/old", "p/new"] },
    })
    expect(before.defaults.model).toBe("p/old")
  })
  it("adds a chat model to effective allowed models without changing other scopes or enabling the chat", () => {
    const before = policy()
    expect(stageModelUse(before, "p/new", "off", "chat", "42")).toEqual({
      ...before,
      chats: {
        ...before.chats,
        "42": {
          ...before.chats["42"],
          model: "p/new",
          thinking: "off",
          models: ["p/old", "p/new"],
        },
      },
    })
  })
  it("clears only model inheritance fields when the selected model is the effective default", () => {
    const before = policy()
    before.chats["42"] = {
      ...inherited,
      ...before.chats["42"],
      enabled: false,
      model: "p/new",
      thinking: "high",
      models: [],
    }
    expect(stageModelUse(before, "p/old", "off", "inherit", "42").chats["42"]).toEqual({
      ...before.chats["42"],
      model: null,
      thinking: null,
      models: null,
    })
    expect(stageModelUse(before, "p/new", "off", "inherit", "42")).toBe(before)
  })
  it("does not drop stored unavailable selections while adding a chat model", () => {
    const before = policy()
    before.chats["42"] = {
      ...inherited,
      ...before.chats["42"],
      enabled: false,
      models: ["p/removed"],
    }
    expect(stageModelUse(before, "p/new", "off", "chat", "42").chats["42"]?.models).toEqual([
      "p/removed",
      "p/new",
    ])
  })
  it("rejects unavailable models and invalid chat IDs", () => {
    const before = policy()
    expect(stageModelUse(before, "p/missing", "off", "defaults", "")).toBe(before)
    for (const id of ["", "0", "0042", "9007199254740992"])
      expect(stageModelUse(before, "p/new", "off", "chat", id)).toBe(before)
  })
})
