import { describe, expect, it } from "vitest"
import { formatMarketTable, priceRows } from "../src/market-data/format.js"

describe("market quote tables", () => {
  it("renders a complete quote as a two-column Markdown table", () => {
    expect(
      formatMarketTable("📊 元大台灣50 (0050)", [
        ...priceRows({
          last: 97.78,
          open: 101.55,
          high: 101.65,
          low: 97.7,
          changeFrom: 100.61,
          currency: "TWD",
          volume: 239424,
          maximumFractionDigits: 2,
        }),
        ["資料來源", "TWSE"],
      ]),
    ).toBe(
      [
        "📊 元大台灣50 (0050)",
        "",
        "| 項目 | 數值 |",
        "| --- | --- |",
        "| 現價 | 97.78 TWD |",
        "| 開盤 | 101.55 TWD |",
        "| 最高 | 101.65 TWD |",
        "| 最低 | 97.7 TWD |",
        "| 漲跌 | 🔻 -2.81% |",
        "| 成交量 | 239,424 |",
        "| 資料來源 | TWSE |",
      ].join("\n"),
    )
  })

  it("omits absent values while preserving zero and price precision", () => {
    expect(priceRows({ last: 0, volume: 0, currency: "USD" })).toEqual([
      ["現價", "0 USD"],
      ["成交量", "0"],
    ])
    expect(priceRows({ last: 0.12345678, maximumFractionDigits: 8 })).toEqual([
      ["現價", "0.12345678"],
    ])
    expect(priceRows({ last: 1, changeFrom: 0 })).toEqual([["現價", "1"]])
    expect(priceRows({})).toEqual([])
  })

  it.each([
    [110, "🔺 +10.00%"],
    [100, "⏸️ +0.00%"],
    [90, "🔻 -10.00%"],
  ])("preserves the change calculation for price %s", (last, expected) => {
    expect(priceRows({ last, changeFrom: 100 })).toContainEqual(["漲跌", expected])
  })

  it("escapes Markdown and prevents upstream values from adding table rows or columns", () => {
    expect(
      formatMarketTable("📊 A | **B**\n(TEST)", [
        ["資料|來源", "[link](https://example.test)\r\n`code`\\path"],
      ]),
    ).toBe(
      [
        "📊 A \\| \\*\\*B\\*\\* (TEST)",
        "",
        "| 項目 | 數值 |",
        "| --- | --- |",
        "| 資料\\|來源 | \\[link\\](https://example.test) \\`code\\`\\\\path |",
      ].join("\n"),
    )
  })
})
