import { inherited, initialPolicy } from "@narumitw/sumire-policy"
import { describe, expect, it } from "vitest"
import type { Inventory } from "./api.js"
import { defaultModelOptions, selectDefaultModel } from "./default-model.js"

const inventory: Inventory = {
  tools: [],
  mcp: [],
  providers: [
    {
      id: "fixture",
      name: "Fixture",
      configured: false,
      apiKey: true,
      oauth: false,
      models: [
        {
          id: "family/test",
          name: "Test",
          thinking: ["off", "high"],
          reasoning: true,
          image: false,
        },
        { id: "unknown", name: "Unknown metadata", thinking: [], reasoning: false, image: false },
        { id: "unapproved", name: "Unapproved", thinking: ["off"], reasoning: false, image: false },
      ],
    },
  ],
}
describe("inline shared model selection", () => {
  it("offers only globally approved models with usable metadata, without requiring credentials", () => {
    const policy = initialPolicy()
    policy.models = ["fixture/family/test", "fixture/unknown", "fixture/missing"]
    expect(defaultModelOptions(policy, inventory)).toEqual([
      { ref: "fixture/family/test", levels: ["off", "high"] },
    ])
    policy.providers = [{ id: "fixture", enabled: false, models: [] }]
    expect(defaultModelOptions(policy, inventory)).toEqual([])
  })
  it.each([null, [], ["old/model"]])(
    "adds one shared allowed reference without losing %j",
    (models) => {
      const selection = { ...inherited, models }
      const before = structuredClone(selection)
      const next = selectDefaultModel(selection, "fixture/family/test", "high")
      expect(next).toEqual({
        ...selection,
        model: "fixture/family/test",
        thinking: "high",
        models: [...(models ?? []), "fixture/family/test"],
      })
      expect(selectDefaultModel(next, "fixture/family/test", "high")).toEqual(next)
      expect(selection).toEqual(before)
    },
  )
})
