import { inherited, initialPolicy } from "@narumitw/sumire-policy"
import { Theme } from "@radix-ui/themes"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Inventory, Snapshot } from "./api.js"
import { ModelRemovalImpact } from "./model-removal-impact.js"
import { withModelAvailability } from "./provider-policy.js"
import { Providers } from "./providers.js"
import { SharedDefaults } from "./shared-defaults.js"

const inventory: Inventory = {
  tools: [],
  mcp: [],
  skills: [{ name: "example", description: "Detailed skill purpose must not be repeated" }],
  providers: [
    {
      id: "fixture",
      name: "Fixture",
      configured: true,
      apiKey: true,
      oauth: true,
      models: [{ id: "model", name: "Model", thinking: ["off"], reasoning: false, image: false }],
    },
    {
      id: "catalog",
      name: "Catalog only",
      configured: false,
      apiKey: true,
      oauth: false,
      models: [],
    },
  ],
}
afterEach(() => vi.unstubAllGlobals())

describe("provider and model workflow presentation", () => {
  it("first renders configured/reference list with explicit management entry, without a wizard or use editor", () => {
    const policy = initialPolicy()
    const html = renderToStaticMarkup(
      createElement(Providers, {
        snapshot: { policy, revision: 1, applied: 1, epoch: 1, status: "applied" } as Snapshot,
        inventory,
        csrf: "fixture",
        dirty: false,
        busy: false,
        error: "",
        savedPolicy: policy,
        onDefaults: vi.fn(),
        onPending: vi.fn(),
        run: vi.fn(),
        refresh: vi.fn(),
      }),
    )
    expect(html).toContain('aria-label="Configured providers"')
    expect(html).toContain("1 個供應商")
    expect(html).toContain('aria-label="Search providers"')
    expect(html).toContain('aria-label="Provider status"')
    expect(html).toContain("Manage provider fixture")
    expect(html).toContain("Add provider")
    expect(html).toContain("Credential configured")
    expect(html).not.toContain("Catalog only")
    expect(html.indexOf('aria-label="Configured providers"')).toBeLessThan(
      html.indexOf("<div hidden"),
    )
    expect(html).not.toContain("Choose model use")
    expect(html).not.toContain("Model setup steps")
  })

  it("reviews disabled and inherited results, reset thinking/lists, restore limits and GitHub uncertainty", () => {
    const policy = initialPolicy()
    policy.models = ["fixture/model"]
    policy.defaults = {
      ...inherited,
      models: ["fixture/model"],
      model: "fixture/model",
      thinking: "high",
    }
    policy.chats = {
      "999999": {
        ...inherited,
        enabled: false,
        models: ["fixture/model"],
        model: "fixture/model",
        thinking: "low",
      },
      "42": { ...inherited, enabled: true },
    }
    const html = renderToStaticMarkup(
      createElement(ModelRemovalImpact, {
        before: policy,
        after: withModelAvailability(policy, []),
      }),
    )
    expect(html).toContain('aria-label="Model removal impact"')
    expect(html).toContain("Chat 999999 (disabled)")
    expect(html).toContain("Chat 42")
    expect(html).toContain("Allowed models: None (empty list)")
    expect(html).toContain("Thinking: Inherit")
    expect(html).toContain("Not configured")
    expect(html).toContain("Restoring availability does not restore")
    expect(html).toContain("GitHub replies use the shared model")
    expect(html).toContain("Worker and pending outbox effects are unknown")
    expect(html).toContain("their complete population is not known")
    expect(
      renderToStaticMarkup(createElement(ModelRemovalImpact, { before: policy, after: policy })),
    ).toBe("")
  })

  it("keeps inline model validation and scoped summary links without detailed tool/skill lists", () => {
    vi.stubGlobal("window", {
      location: { href: "https://admin.example/?section=Defaults&chat=42" },
    })
    const policy = initialPolicy()
    policy.models = ["fixture/model"]
    policy.tools = ["private_tool_detail"]
    policy.skills = ["example"]
    policy.defaults = {
      ...inherited,
      model: "fixture/model",
      models: ["fixture/model"],
      thinking: "max",
      tools: ["private_tool_detail"],
      skills: ["example"],
    }
    const html = renderToStaticMarkup(
      createElement(
        Theme,
        {},
        createElement(SharedDefaults, {
          policy,
          saved: policy,
          inventory,
          chat: "42",
          onChange: vi.fn(),
          navigate: vi.fn(),
          onProvider: vi.fn(),
        }),
      ),
    )
    expect(html).toContain("Shared default model")
    expect(html).toContain("Choose a supported thinking level before saving")
    expect(html).toContain("Manage default tool permissions")
    expect(html).toContain("Manage default skills")
    expect(html).toContain("Manage default server gates")
    expect(html).toContain("Manage MCP servers")
    expect(html).toContain("default-tool-permissions")
    expect(html).not.toContain("private_tool_detail")
    expect(html).not.toContain("Detailed skill purpose must not be repeated")
    expect(html).not.toContain("Default tool summary")
    expect(html).not.toContain("Default skill summary")
    expect(html).toContain("共用選項不會覆蓋聊天的個別設定。")
  })
})
