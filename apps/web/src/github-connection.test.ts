import { Theme } from "@radix-ui/themes"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import { GitHubConnection } from "./github-connection.js"
import { githubApplicationStatusLabel, parseGitHubApplication } from "./github-state.js"
import { setLocale } from "./i18n.js"

afterEach(() => setLocale("en"))

describe("GitHub connection localization", () => {
  it.each([
    ["en", "Connect GitHub", "Current settings revision 3; applied 2; failed.", "failed"],
    ["zh-TW", "連線至 GitHub", "目前設定修訂 3；已套用 2；失敗。", "失敗"],
    ["ja", "GitHub に接続", "現在の設定リビジョン 3、適用済み 2、失敗。", "失敗"],
  ] as const)(
    "renders %s application labels without changing status data",
    (locale, heading, state, failed) => {
      setLocale(locale)
      const application = parseGitHubApplication({ revision: 3, applied: 2, status: "failed" })
      const html = renderToStaticMarkup(
        createElement(
          Theme,
          {},
          createElement(GitHubConnection, {
            csrf: "fixture",
            blocked: false,
            revision: 3,
            application,
            guard: { current: undefined },
            onPending: () => {},
            onCommitted: () => {},
            onSessionExpired: () => {},
            refresh: async () => {},
          }),
        ),
      )
      expect(html).toContain(heading)
      expect(html).toContain(state)
      expect(html).toContain("Client ID")
      expect(html).toContain("read:org")
      expect(application.status).toBe("failed")
      expect(githubApplicationStatusLabel("failed")).toBe(failed)
      expect(githubApplicationStatusLabel("opaque-upstream-status")).toBe("opaque-upstream-status")
    },
  )
})
