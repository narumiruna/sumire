import { initialPolicy } from "@narumitw/sumire-policy"
import { Theme } from "@radix-ui/themes"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import { ChatAccess } from "./chat-access.js"
import { setLocale } from "./i18n.js"

afterEach(() => setLocale("en"))

describe("chat access localization", () => {
  it("localizes staged changes, search labels and actions without changing identities", () => {
    const saved = initialPolicy()
    saved.privateUsers = [42]
    const policy = { ...saved, privateUsers: [43] }
    for (const [locale, title, search, summary, revoke, undo] of [
      [
        "en",
        "Approve a chat",
        "Search private-message access",
        "1–2 of 2 · 1 pending approval · 1 pending revocation",
        "Revoke access for ID 43",
        "Undo revocation for 42",
      ],
      [
        "zh-TW",
        "核准聊天",
        "搜尋私人訊息存取權限",
        "1–2，共 2 筆 · 1 筆等待核准 · 1 筆等待撤銷",
        "撤銷 ID 43 的存取權限",
        "復原 42 的撤銷",
      ],
      [
        "ja",
        "チャットを承認",
        "プライベートメッセージのアクセスを検索",
        "2 件中 1–2 件 · 1 件が承認待ち · 1 件が取り消し待ち",
        "ID 43 のアクセスを取り消す",
        "42 の取り消しを元に戻す",
      ],
    ] as const) {
      setLocale(locale)
      const html = renderToStaticMarkup(
        createElement(
          Theme,
          {},
          createElement(ChatAccess, {
            policy,
            saved,
            target: "",
            chats: [{ id: 43, type: "private", name: "使用者 <43>" }],
            onChange() {},
            onPending() {},
            onReview() {},
          }),
        ),
      )
      expect(html).toContain(title)
      expect(html).toContain(search)
      expect(html).toContain(summary)
      expect(html).toContain(`aria-label="${revoke}"`)
      expect(html).toContain(undo)
      expect(html).toContain("使用者 &lt;43&gt;")
      expect(html).toContain('id="access-id-input"')
    }
  })
})
