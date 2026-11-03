import { describe, expect, it } from "vitest"
import { sanitizeTelegramText } from "../src/telegram/rendering.js"

describe("Telegram source normalization", () => {
  it("normalizes CRLF/CR and preserves tabs, newlines and Unicode", () => {
    expect(sanitizeTelegramText("中文🌸\r\n\ttext\rnext")).toBe("中文🌸\n\ttext\nnext")
  })
  it("drops invalid controls and unpaired surrogates, not Markdown", () => {
    expect(sanitizeTelegramText("\u0000\u0008\ud800**文字** `<tag>`\udfff")).toBe(
      "**文字** `<tag>`",
    )
  })
})
