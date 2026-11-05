import { inherited, initialPolicy } from "@narumitw/sumire-policy"
import { Theme } from "@radix-ui/themes"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Inventory, Snapshot } from "./api.js"
import { setLocale } from "./i18n.js"
import { providersMessages as enMessages } from "./locales/en/providers.js"
import { providersMessages as jaMessages } from "./locales/ja/providers.js"
import { providersMessages as zhTWMessages } from "./locales/zh-tw/providers.js"
import { ModelRemovalImpact } from "./model-removal-impact.js"
import { ModelSetup } from "./model-setup.js"
import { ProviderEditor } from "./provider-editor.js"
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
afterEach(() => {
  setLocale("en")
  vi.unstubAllGlobals()
})

describe("provider and model workflow presentation", () => {
  it("provides all three translations with the same interpolation fields", () => {
    const fields = (message: string) =>
      [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    const keys = Object.keys(enMessages) as (keyof typeof enMessages)[]
    for (const catalog of [enMessages, zhTWMessages, jaMessages]) {
      expect(Object.keys(catalog).sort()).toEqual([...keys].sort())
      for (const key of keys) {
        expect(catalog[key].trim(), key).not.toBe("")
        expect(fields(catalog[key]), key).toEqual(fields(enMessages[key]))
      }
    }
  })

  it.each([
    ["zh-TW", "已設定的供應商", "供應商 ID", "需要驗證", "模型移除影響", "聊天 42（已停用）"],
    [
      "ja",
      "設定済みプロバイダー",
      "プロバイダー ID",
      "認証が必要",
      "モデル削除の影響",
      "チャット 42（無効）",
    ],
  ] as const)(
    "localizes provider setup and removal review in %s without changing metadata",
    (locale, directory, providerId, authentication, impact, disabledChat) => {
      setLocale(locale)
      const policy = initialPolicy()
      policy.models = ["fixture/model"]
      policy.defaults = {
        ...inherited,
        model: "fixture/model",
        models: ["fixture/model"],
        thinking: "high",
      }
      policy.chats["42"] = { ...inherited, enabled: false, model: "fixture/model" }
      const before = structuredClone(policy)
      const html = renderToStaticMarkup(
        createElement(
          Theme,
          null,
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
        ),
      )
      expect(html).toContain(directory)
      expect(html).toContain("Fixture")
      expect(html).toContain(
        'aria-label="' +
          (locale === "ja" ? "プロバイダー fixture を管理" : "管理供應商 fixture") +
          '"',
      )
      expect(html).not.toContain("Configured providers")
      const editor = renderToStaticMarkup(
        createElement(
          Theme,
          null,
          createElement(ProviderEditor, {
            initial: {
              id: "fixture",
              enabled: true,
              baseUrl: "https://example.com/v1",
              models: [
                {
                  id: "model",
                  name: "自訂模型",
                  reasoning: true,
                  image: true,
                  contextWindow: 100,
                  maxTokens: 50,
                },
              ],
            },
            onAdd: vi.fn(),
            onPending: vi.fn(),
            onDiscard: vi.fn(),
          }),
        ),
      )
      expect(editor).toContain(providerId)
      expect(editor).toContain("https://example.com/v1")
      expect(editor).toContain("自訂模型")
      expect(editor).not.toContain("Advanced model metadata")
      const setup = renderToStaticMarkup(
        createElement(ModelSetup, {
          scope: "Fixture scope",
          model: "fixture/model",
          selected: "fixture/model",
          inventory: {
            ...inventory,
            providers: inventory.providers.map((provider) => ({ ...provider, configured: false })),
          },
          onModel: vi.fn(),
          onProvider: vi.fn(),
        }),
      )
      expect(setup).toContain(authentication)
      expect(setup).toContain("fixture/model")
      const removal = renderToStaticMarkup(
        createElement(ModelRemovalImpact, {
          before: policy,
          after: withModelAvailability(policy, []),
        }),
      )
      expect(removal).toContain(impact)
      expect(removal).toContain(disabledChat)
      expect(removal).toContain("fixture/model")
      expect(removal).not.toContain("Restoring availability does not restore")
      expect(policy).toEqual(before)
    },
  )

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
    expect(html).toContain("1 provider")
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
    expect(html).toContain("Shared selections do not override individual chat settings.")
  })
})
