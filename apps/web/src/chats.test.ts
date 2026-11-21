import { initialPolicy } from "@narumitw/sumire-policy"
import { Theme } from "@radix-ui/themes"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Inventory } from "./api.js"
import type { ChatDirectory } from "./chat-directory.js"
import { ChatWorkspace } from "./chats.js"
import { setLocale } from "./i18n.js"

afterEach(() => {
  setLocale("en")
  vi.unstubAllGlobals()
})

describe("chat workspace localization", () => {
  it("localizes details, draft notices and issue actions while preserving chat metadata", () => {
    vi.stubGlobal("window", { location: { href: "https://example.test/?section=Chats" } })
    const savedPolicy = initialPolicy()
    const policy = { ...savedPolicy, privateUsers: [42] }
    const chat = { id: 42, name: "聊天 <42>", type: "private" }
    const directory: ChatDirectory = {
      chats: [chat],
      knownChats: [chat],
      loading: false,
      error: "",
      query: "",
      offset: 0,
      setQuery() {},
      setOffset() {},
      refresh() {},
      selected: { chat, loading: false, error: "" },
    }
    const inventory: Inventory = { tools: [], mcp: [], providers: [] }
    for (const [locale, details, views, issueAction, draft, history] of [
      [
        "en",
        "Chat details",
        "Selected chat views",
        "Review access approval",
        "Draft preview — not saved:",
        "Chat-targeted audit history",
      ],
      [
        "zh-TW",
        "聊天詳細資料",
        "所選聊天檢視",
        "檢視存取核准",
        "草稿預覽 — 尚未儲存：",
        "針對聊天的稽核記錄",
      ],
      [
        "ja",
        "チャットの詳細",
        "選択したチャットの表示",
        "アクセス承認を確認",
        "下書きのプレビュー — 未保存：",
        "チャットを対象とした監査履歴",
      ],
    ] as const) {
      setLocale(locale)
      const html = renderToStaticMarkup(
        createElement(
          Theme,
          {},
          createElement(ChatWorkspace, {
            directory,
            chat: "42",
            busy: false,
            detailsRequest: 0,
            policy,
            savedPolicy,
            application: { revision: 1, applied: 1, status: "applied" },
            inventory,
            onSelect() {},
            onAccess() {},
            onApplication() {},
            onProviders() {},
            onTools() {},
            onDurable() {},
            onPolicyChange() {},
            audit: [],
            onAudit() {},
            // biome-ignore lint/correctness/noChildrenProp: ChatWorkspace requires children in its props type.
            children: null,
          }),
        ),
      )
      expect(html).toContain(`aria-label="${details}"`)
      expect(html).toContain(`aria-label="${views}"`)
      expect(html).toContain(issueAction)
      expect(html).toContain(draft)
      expect(html).toContain(history)
      expect(html).toContain("聊天 &lt;42&gt;")
      expect(html).toContain(">private<")
      expect(html).toContain('data-view="configuration"')
      expect(html).toContain("section=Chats")
    }
  })
})
