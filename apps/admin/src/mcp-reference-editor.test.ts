import { Theme } from "@radix-ui/themes"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import { setLocale } from "./i18n.js"
import { McpGuidedEditor } from "./mcp-editor.js"
import { McpReferenceEditor } from "./mcp-reference-editor.js"

afterEach(() => setLocale("en"))

describe("MCP editor localization", () => {
  it.each([
    [
      "en",
      "Binding scope",
      "Stage stored reference",
      "Connection command",
      "Advanced connection fields",
    ],
    ["zh-TW", "繫結範圍", "暫存已儲存參照", "連線命令", "進階連線欄位"],
    ["ja", "バインド範囲", "保存済み参照を準備", "接続コマンド", "接続の詳細フィールド"],
  ] as const)(
    "renders %s labels without changing references, commands, or exposure",
    (locale, scope, stage, command, advanced) => {
      setLocale(locale)
      const reference = renderToStaticMarkup(
        createElement(
          Theme,
          {},
          createElement(McpReferenceEditor, {
            onAdd: () => {},
            onPending: () => {},
            run: async () => {},
          }),
        ),
      )
      expect(reference).toContain(scope)
      expect(reference).toContain(stage)
      expect(reference).toContain("$" + "{NAME}")
      expect(reference).not.toContain("\\" + "$" + "{NAME}")
      expect(reference).toContain("Bearer ")
      const editor = renderToStaticMarkup(
        createElement(
          Theme,
          {},
          createElement(McpGuidedEditor, {
            text: JSON.stringify({ command: "fixture-command", exposure: "hidden" }),
            onChange: () => {},
          }),
        ),
      )
      expect(editor).toContain(command)
      expect(editor).toContain(advanced)
      expect(editor).toContain('value="fixture-command"')
    },
  )
})
