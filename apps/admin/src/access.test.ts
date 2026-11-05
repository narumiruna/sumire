import { initialPolicy } from "@narumitw/sumire-policy"
import { Theme } from "@radix-ui/themes"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import { AccessApproval } from "./access.js"
import type { Snapshot } from "./api.js"
import { setLocale } from "./i18n.js"

afterEach(() => setLocale("en"))

describe("access approval localization", () => {
  it("localizes the unresolved request and its accessibility label on each render", () => {
    const snapshot = {
      revision: 1,
      applied: 1,
      status: "applied",
      policy: initialPolicy(),
    } as Snapshot
    for (const [locale, label, heading, notice, reload, dismiss] of [
      [
        "en",
        "Chat access approval request",
        "Review chat access",
        "Load and review the chat before approval.",
        "Reload request",
        "Dismiss request",
      ],
      [
        "zh-TW",
        "聊天存取核准請求",
        "檢視聊天存取權限",
        "請先載入並檢視聊天，再核准。",
        "重新載入請求",
        "關閉請求",
      ],
      [
        "ja",
        "チャットアクセスの承認リクエスト",
        "チャットアクセスを確認",
        "承認する前にチャットを読み込んで確認してください。",
        "リクエストを再読み込み",
        "リクエストを閉じる",
      ],
    ] as const) {
      setLocale(locale)
      const html = renderToStaticMarkup(
        createElement(
          Theme,
          {},
          createElement(AccessApproval, {
            token: "opaque-token",
            clear() {},
            csrf: "",
            snapshot,
            disabled: false,
            async run() {},
            async refresh() {},
          }),
        ),
      )
      expect(html).toContain(`aria-label="${label}"`)
      for (const text of [heading, notice, reload, dismiss]) expect(html).toContain(text)
      expect(html).not.toContain("opaque-token")
    }
  })
})
