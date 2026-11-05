import { Theme } from "@radix-ui/themes"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import { setLocale } from "./i18n.js"
import { RuntimeConfig } from "./runtime-config.js"

afterEach(() => setLocale("en"))

describe("runtime configuration localization", () => {
  it.each([
    ["en", "Secrets", "Variables", "Loading runtime metadata…", "Saved secrets are write-only."],
    ["zh-TW", "機密", "變數", "正在載入執行階段中繼資料…", "已儲存的機密只能寫入。"],
    [
      "ja",
      "シークレット",
      "変数",
      "ランタイムメタデータを読み込んでいます…",
      "保存済みシークレットは書き込み専用です。",
    ],
  ] as const)(
    "renders %s controls and preserves runtime kinds",
    (locale, secret, variable, loading, help) => {
      setLocale(locale)
      const html = renderToStaticMarkup(
        createElement(
          Theme,
          {},
          createElement(RuntimeConfig, {
            csrf: "fixture",
            blocked: false,
            revision: 1,
            guard: { current: undefined },
            onPending: () => {},
            onCommitted: () => {},
            onSessionExpired: () => {},
            refresh: async () => {},
          }),
        ),
      )
      expect(html).toContain(secret)
      expect(html).toContain(variable)
      expect(html).toContain(help)
      expect(html).not.toContain(loading)
      expect(html).toContain('-content-secret"')
      expect(html).toContain('-content-variable"')
      expect(html).toContain("GH_TOKEN")
      expect(html).not.toContain('type="password"')
    },
  )
})
