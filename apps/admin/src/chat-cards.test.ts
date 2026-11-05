import { inherited, initialPolicy } from "@narumitw/sumire-policy"
import { Theme } from "@radix-ui/themes"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Inventory, Policy } from "./api.js"
import { ChatCard, chatModelName, matchesChatScope } from "./chat-cards.js"

const chat = { id: -100, name: "測試 <群組>", type: "supergroup" }
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
      models: [
        { id: "test", name: "Test model", thinking: ["off"], reasoning: false, image: false },
      ],
    },
  ],
}
function policy() {
  const value = initialPolicy()
  value.groups = [-100]
  value.models = ["fixture/test"]
  value.defaults.models = ["fixture/test"]
  value.defaults.model = "fixture/test"
  return value
}
function render(saved = policy(), draft: Policy = saved) {
  vi.stubGlobal("window", { location: { href: "https://example.test/?section=Chats" } })
  return renderToStaticMarkup(
    createElement(
      Theme,
      {},
      createElement(ChatCard, {
        chat,
        selected: "",
        policy: draft,
        savedPolicy: saved,
        inventory,
        application: { revision: 1, applied: 1, status: "applied" },
        busy: false,
        onOpen() {},
        onConfigure() {},
        onRepair() {},
        onChange() {},
      }),
    ),
  )
}
afterEach(() => vi.unstubAllGlobals())

describe("chat card saved-state presentation", () => {
  it("shows only concise model facts, not raw IDs or readiness claims", () => {
    const html = render()
    expect(html).toContain("測試 &lt;群組&gt;")
    expect(html).toContain("Test model")
    expect(html).toContain("共用設定")
    expect(html).toContain("已啟用")
    expect(html).not.toContain("Configured locally")
    expect(html).not.toContain("需要處理")
    expect(html).not.toContain("Copy ID")
    expect(html.match(/<a\b[^>]*>([\s\S]*?)<\/a>/)?.[1]).not.toContain("<button")
  })
  it("shows pending approval without displaying model or source facts", () => {
    const saved = policy()
    saved.groups = []
    const html = render(saved)
    expect(html).toContain("等待管理員核准")
    expect(html).toContain("待核准")
    expect(html).not.toContain("chat-card-facts")
  })
  it("does not pretend a staged grant is already applied", () => {
    const saved = policy()
    saved.groups = []
    const draft = { ...saved, groups: [-100] }
    const html = render(saved, draft)
    expect(html).toContain("待核准")
    expect(html).toContain("核准待儲存")
    expect(html).not.toContain('data-status="enabled"')
  })
  it("does not pretend a staged revocation has already disabled the chat", () => {
    const saved = policy()
    const html = render(saved, { ...saved, groups: [] })
    expect(html).toContain('data-status="enabled"')
    expect(html).toContain("撤銷核准待儲存")
  })
  it("distinguishes disabled from unapproved", () => {
    const saved = policy()
    saved.chats["-100"] = { ...inherited, enabled: false }
    const html = render(saved)
    expect(html).toContain('data-status="disabled"')
    expect(html).toContain("聊天已停用")
    expect(html).not.toContain("等待管理員核准")
  })
  it("shows a concise actionable warning without verbose authentication details", () => {
    const saved = policy()
    saved.defaults.model = null
    const html = render(saved)
    expect(html).toContain("需要處理")
    expect(html).toContain("尚未設定")
    expect(html).not.toContain("No effective model configured")
  })
})

describe("chat directory summaries and filters", () => {
  it("uses inventory display names and a provider-free fallback without rewriting model IDs", () => {
    expect(chatModelName("fixture/test", inventory)).toBe("Test model")
    expect(chatModelName("fixture/unknown-model", inventory)).toBe("unknown-model")
    expect(chatModelName("bare-model", inventory)).toBe("bare-model")
    expect(chatModelName(null, inventory)).toBe("尚未設定")
  })
  it("keeps disabled but approved chats out of pending approval", () => {
    const saved = policy()
    saved.chats["-100"] = { ...inherited, enabled: false }
    expect(matchesChatScope(chat, saved, "all")).toBe(true)
    expect(matchesChatScope(chat, saved, "pending")).toBe(false)
    expect(matchesChatScope(chat, saved, "enabled")).toBe(false)
  })
  it("handles private access separately from group approval", () => {
    const saved = policy()
    const privateChat = { ...chat, id: 42, type: "private" }
    expect(matchesChatScope(privateChat, saved, "pending")).toBe(true)
    saved.privateUsers = [42]
    expect(matchesChatScope(privateChat, saved, "enabled")).toBe(true)
    expect(matchesChatScope(privateChat, saved, "pending")).toBe(false)
  })
})
