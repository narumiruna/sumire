import { inherited, initialPolicy } from "@narumitw/sumire-policy"
import { describe, expect, it } from "vitest"
import type { Inventory } from "./api.js"
import { chatState } from "./chat-state.js"

function fixture() {
  const policy = initialPolicy()
  policy.privateUsers = [42]
  policy.models = ["fixture/test"]
  policy.defaults = { ...policy.defaults, model: "fixture/test", models: ["fixture/test"] }
  const inventory: Inventory = {
    tools: [],
    mcp: [],
    providers: [
      {
        id: "fixture",
        name: "Fixture",
        configured: true,
        apiKey: true,
        oauth: false,
        models: [{ id: "test", name: "Test", thinking: ["off"], reasoning: false, image: false }],
      },
    ],
  }
  const application = { revision: 2, applied: 2, status: "applied" }
  return { policy, inventory, application }
}

describe("saved chat state", () => {
  it("does not mistake local configuration for successful execution", () => {
    const { policy, inventory, application } = fixture()
    expect(chatState(42, policy, inventory, application)).toMatchObject({
      approved: true,
      enabled: true,
      label: "Configured locally",
      reason: "Model response not checked.",
      issues: [],
    })
  })
  it("keeps approval and the enabled switch independent, including group approval", () => {
    const { policy, inventory, application } = fixture()
    policy.chats["42"] = { ...inherited, enabled: false }
    expect(chatState(42, policy, inventory, application).primary?.code).toBe("disabled")
    policy.privateUsers = []
    expect(chatState(42, policy, inventory, application).issues.map((issue) => issue.code)).toEqual(
      ["approval", "disabled"],
    )
    policy.groups = [-100]
    expect(chatState(-100, policy, inventory, application).approved).toBe(true)
    expect(chatState(-101, policy, inventory, application).approved).toBe(false)
  })
  it.each(["missing", "disallowed", "disabled provider"])("reports %s model setup", (kind) => {
    const { policy, inventory, application } = fixture()
    if (kind === "missing") policy.defaults.model = null
    if (kind === "disallowed") policy.models = []
    if (kind === "disabled provider")
      policy.providers = [{ id: "fixture", enabled: false, models: [] }]
    expect(chatState(42, policy, inventory, application).primary).toMatchObject({
      code: "model",
      label: "Setup required",
      target: "model",
    })
  })
  it("reports missing local authentication, not failed remote verification", () => {
    const { policy, inventory, application } = fixture()
    inventory.providers.forEach((provider) => {
      provider.configured = false
    })
    expect(chatState(42, policy, inventory, application).primary).toMatchObject({
      code: "authentication",
      reason: "Model authentication is not configured.",
      target: "providers",
    })
  })
  it.each(["missing inventory", "missing provider", "missing model"])(
    "reports unknown for %s",
    (kind) => {
      const { policy, inventory, application } = fixture()
      if (kind === "missing provider") inventory.providers = []
      if (kind === "missing model")
        inventory.providers.forEach((provider) => {
          provider.models = []
        })
      expect(
        chatState(42, policy, kind === "missing inventory" ? undefined : inventory, application)
          .primary,
      ).toMatchObject({ code: "inventory", label: "Status unknown" })
    },
  )
  it.each([
    { status: "pending", applied: 2, code: "application-pending" },
    { status: "applied", applied: 1, code: "application-pending" },
    { status: "failed", applied: 2, code: "application-failed" },
  ])("reports application state with $status and applied $applied", ({ status, applied, code }) => {
    const { policy, inventory, application } = fixture()
    expect(
      chatState(42, policy, inventory, { ...application, status, applied }).primary?.code,
    ).toBe(code)
  })
  it("prioritizes access, application, setup, then unknown information without dropping issues", () => {
    const { policy, inventory, application } = fixture()
    policy.privateUsers = []
    inventory.providers.forEach((provider) => {
      provider.configured = false
      provider.models = []
    })
    const state = chatState(42, policy, inventory, { ...application, status: "failed" })
    expect(state.issues.map((issue) => issue.code)).toEqual([
      "approval",
      "application-failed",
      "authentication",
      "inventory",
    ])
  })
  it("does not repair saved state with an unsaved approval, model, or enabled draft", () => {
    const { policy, inventory, application } = fixture()
    policy.privateUsers = []
    policy.chats["42"] = { ...inherited, enabled: false, model: "missing/test" }
    const draft = structuredClone(policy)
    draft.privateUsers = [42]
    draft.chats["42"] = { ...inherited, enabled: true }
    expect(chatState(42, draft, inventory, application).issues).toEqual([])
    expect(chatState(42, policy, inventory, application).issues.map((issue) => issue.code)).toEqual(
      ["approval", "disabled", "model"],
    )
  })
})
