import { effectivePolicy, inherited, initialPolicy } from "@narumitw/sumire-policy"
import { Theme } from "@radix-ui/themes"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import type { Policy } from "./api.js"
import { Choices, ModelAvailability } from "./policy-editors.js"

function fixture() {
  const policy = initialPolicy()
  policy.tools = ["read"]
  policy.servers = ["search"]
  policy.skills = ["review"]
  policy.models = ["provider/model"]
  policy.defaults = {
    tools: ["read"],
    servers: ["search"],
    skills: ["review"],
    models: ["provider/model"],
    model: "provider/model",
    thinking: "high",
  }
  return { ...policy, chats: { "42": { ...inherited, enabled: true } } }
}

function renderChoices(policy: Policy, defaults = false) {
  const onChange = vi.fn()
  const html = renderToStaticMarkup(
    createElement(
      Theme,
      null,
      createElement(Choices, {
        policy,
        value: defaults ? policy.defaults : (policy.chats["42"] ?? inherited),
        effective: effectivePolicy(policy, defaults ? 0 : 42),
        inventory: { tools: [], providers: [], mcp: [] },
        defaults,
        navigate: vi.fn(),
        onChange,
      }),
    ),
  )
  expect(onChange).not.toHaveBeenCalled()
  return html
}

function fieldset(html: string, legend: string) {
  const content = html.split(`<legend>${legend}</legend>`)[1]
  expect(content).toBeDefined()
  return content?.split("</fieldset>")[0] ?? ""
}

const lists = ["Authorized tools", "Authorized MCP servers", "Enabled skills", "Allowed models"]

describe("policy field scope and source labels", () => {
  it("labels every inherited chat list and both inherited scalar fields", () => {
    const html = renderChoices(fixture())
    for (const label of lists) {
      const list = fieldset(html, label)
      expect(list).toContain("From shared defaults")
      expect(list).toContain("Uses shared defaults.")
      expect(list).toContain("Global availability still limits this chat.")
      expect(list).toContain('aria-label="Inherit default"')
      expect(list).not.toContain("No options allowed")
      expect(list).not.toContain(`Reset ${label.toLowerCase()} to default`)
    }
    expect(html.split("From shared defaults")).toHaveLength(7)
    expect(html).toContain('aria-label="Chat model override"')
    expect(html).toContain('aria-label="Thinking level"')
    expect(html).toContain('aria-describedby="model-selection-source"')
    expect(html).toContain('aria-describedby="thinking-selection-source"')
    expect(html).toContain("Effective model: provider/model")
    expect(html).toContain("Effective thinking: high")
    expect(html).not.toContain("Reset model and thinking to default")
  })

  it("distinguishes explicit empty chat lists from inheritance and retains reset controls", () => {
    const policy = fixture()
    Object.assign(policy.chats["42"], {
      tools: [],
      servers: [],
      skills: [],
      models: [],
    })
    const before = structuredClone(policy)
    const html = renderChoices(policy)
    for (const label of lists) {
      const list = fieldset(html, label)
      expect(list).toContain("This chat override")
      expect(list).toContain("No options allowed. This does not inherit shared defaults.")
      expect(list).toContain("Shared defaults do not change.")
      expect(list).toContain("Effective: None")
      expect(list).toContain(`Reset ${label.toLowerCase()} to default`)
    }
    expect(policy).toEqual(before)
  })

  it("labels model and thinking sources separately, including an explicit off override", () => {
    const policy = fixture()
    policy.chats["42"].thinking = "off"
    let modelFields = fieldset(renderChoices(policy), "Model and thinking")
    expect(modelFields).toContain("From shared defaults · No override for this chat.")
    expect(modelFields).toContain("This chat override. Shared defaults do not change.")
    expect(modelFields).toContain("Effective thinking: off")
    expect(modelFields).toContain("Reset model and thinking to default")

    policy.chats["42"].model = "provider/model"
    policy.chats["42"].thinking = null
    modelFields = fieldset(renderChoices(policy), "Model and thinking")
    expect(modelFields).toContain("This chat override. Shared defaults do not change.")
    expect(modelFields).toContain("Effective model: provider/model")
    expect(modelFields).toContain("From shared defaults · No override for this chat.")
    expect(modelFields).toContain("Effective thinking: high")
  })

  it.each([false, true])(
    "shows retained selections blocked by global availability (inherited: %s)",
    (inherit) => {
      const policy = fixture()
      policy.defaults.tools = ["removed-tool"]
      policy.defaults.models = ["removed/model"]
      policy.defaults.model = "removed/model"
      if (!inherit) {
        policy.chats["42"].tools = ["removed-tool"]
        policy.chats["42"].models = ["removed/model"]
        policy.chats["42"].model = "removed/model"
      }
      const html = renderChoices(policy)
      expect(fieldset(html, "Authorized tools")).toContain(
        "Selected but blocked by Global availability: removed-tool.",
      )
      const models = fieldset(html, "Allowed models")
      expect(models).toContain("Selected but blocked by Global availability: removed/model.")
      expect(models).toContain("Effective: None")
      expect(models).toContain(inherit ? "From shared defaults" : "This chat override")
      if (!inherit) expect(models).toContain('aria-label="removed/model (no longer available)"')
      expect(html).toContain("Effective model: No allowed model")
    },
  )

  it("labels shared list, model, and thinking defaults without chat override controls", () => {
    const html = renderChoices(fixture(), true)
    expect(html.split(">Shared defaults<")).toHaveLength(4)
    expect(fieldset(html, "Allowed models")).toContain(
      "Used by chats without an override. Global availability still limits this selection.",
    )
    expect(html).not.toContain('aria-label="Inherit default"')
    expect(html).not.toContain("From shared defaults")
    expect(html).not.toContain("This chat override")
    expect(html).toContain("Edit default model in Model providers")
  })

  it("does not describe null shared lists as inheriting global availability", () => {
    const policy = fixture()
    policy.defaults.models = null
    const models = fieldset(renderChoices(policy, true), "Allowed models")
    expect(models).toContain("Shared defaults")
    expect(models).toContain("Global availability does not select default options.")
    expect(models).toContain("Effective: None")
    expect(models).not.toContain("null inherits shared defaults")
  })

  it("distinguishes an empty shared default list from global availability", () => {
    const policy = fixture()
    policy.defaults.models = []
    const models = fieldset(renderChoices(policy, true), "Allowed models")
    expect(models).toContain("Shared defaults")
    expect(models).toContain("No options allowed for chats that inherit shared defaults.")
    expect(models).toContain("Effective: None")
    expect(models).not.toContain('aria-label="Inherit default"')
  })

  it("labels the global availability limit without claiming that it grants chat access", () => {
    const html = renderToStaticMarkup(
      createElement(ModelAvailability, { value: [], onChange: vi.fn() }),
    )
    expect(html).toContain("<legend>Globally available models</legend>")
    expect(html).toContain(">Global availability<")
    expect(html).toContain("Availability alone does not select an option for a chat.")
    expect(html).toContain("No options available globally.")
    expect(html).not.toContain('aria-label="Inherit default"')
  })
})
