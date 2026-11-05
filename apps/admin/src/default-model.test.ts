import { inherited, initialPolicy } from "@narumitw/sumire-policy"
import { afterEach, describe, expect, it } from "vitest"
import type { Inventory } from "./api.js"
import { defaultModelOptions, selectDefaultModel, thinkingLabel } from "./default-model.js"
import { setLocale } from "./i18n.js"

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
afterEach(() => setLocale("en"))

describe("inline shared model selection", () => {
  it("translates thinking labels at call time without changing selection values or unknown metadata", () => {
    expect(thinkingLabel("off")).toBe("off")
    setLocale("zh-TW")
    expect(thinkingLabel("off")).toBe("關閉")
    expect(thinkingLabel("high")).toBe("高")
    setLocale("ja")
    expect(thinkingLabel("off")).toBe("オフ")
    expect(thinkingLabel("minimal")).toBe("最小")
    expect(thinkingLabel("max")).toBe("最大")
    expect(thinkingLabel("external-level")).toBe("external-level")
    const selection = selectDefaultModel(inherited, "fixture/model", "high")
    expect(selection.thinking).toBe("high")
  })

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
