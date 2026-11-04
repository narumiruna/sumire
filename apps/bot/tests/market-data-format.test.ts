import { describe, expect, it } from "vitest"
import {
  formatMarketResults,
  formatMarketTable,
  type MarketQuote,
} from "../src/market-data/format.js"

const quote: MarketQuote = {
  name: "元大台灣50",
  symbol: "0050",
  source: "TWSE",
  prices: {
    last: 97.78,
    open: 101.55,
    high: 101.65,
    low: 97.7,
    changeFrom: 100.61,
    currency: "TWD",
    volume: 239424,
  },
}

describe("market quote tables", () => {
  it("renders C layout with full names, bold prices and signed changes, and two decimals", () => {
    expect(formatMarketResults([quote])).toBe(
      [
        "| 標的 | 現價 | 漲跌幅 | 開盤 | 最高 | 最低 | 成交量 |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
        "| **0050 元大台灣50** | **97.78** | **🔻 -2.81%** | 101.55 | 101.65 | 97.70 | 239,424 |",
        "",
        "價格單位：TWD｜資料來源：TWSE",
      ].join("\n"),
    )
  })

  it("combines same-unit same-source quotes under one header and footer", () => {
    const second: MarketQuote = { ...quote, symbol: "2330", name: "台積電" }
    const result = formatMarketResults([quote, second])
    expect(result.match(/\| 標的 \|/gu)).toHaveLength(1)
    expect(result.match(/資料來源：TWSE/gu)).toHaveLength(1)
    expect(result).toContain("**0050 元大台灣50**")
    expect(result).toContain("**2330 台積電**")
  })

  it("separates units and sources rather than sharing misleading footer metadata", () => {
    const result = formatMarketResults([
      quote,
      { ...quote, source: "Yahoo Finance" },
      { ...quote, prices: { ...quote.prices, currency: "USD" } },
    ])
    expect(result.match(/\| 標的 \|/gu)).toHaveLength(3)
    expect(result).toContain("價格單位：TWD｜資料來源：TWSE")
    expect(result).toContain("價格單位：TWD｜資料來源：Yahoo Finance")
    expect(result).toContain("價格單位：USD｜資料來源：TWSE")
  })

  it("shows absent values as dashes without dropping zero or inventing a currency", () => {
    const result = formatMarketResults([
      {
        name: "TEST",
        symbol: "TEST",
        source: "Yahoo Finance",
        prices: { last: 0, volume: 0, changeFrom: 0 },
      },
    ])
    expect(result).toContain("| **TEST** | **0.00** | — | — | — | — | 0 |")
    expect(result).toContain("價格單位：未提供")
    expect(formatMarketResults([])).toBe("")
  })

  it.each([
    [110, "🔺 +10.00%"],
    [100, "⏸️ +0.00%"],
    [90, "🔻 -10.00%"],
  ])("preserves signed changes and icons for price %s", (last, expected) => {
    expect(formatMarketResults([{ ...quote, prices: { last, changeFrom: 100 } }])).toContain(
      `**${expected}**`,
    )
  })

  it("retains crypto precision and optional bid/ask columns", () => {
    const result = formatMarketResults([
      {
        name: "MAX Exchange",
        symbol: "BTC/USDT",
        source: "MAX Exchange",
        prices: { last: 0.00001234, bid: 0.000012, ask: 0.00001235, maximumFractionDigits: 8 },
      },
      { ...quote, prices: {} },
    ])
    expect(result).toContain("**0.00001234**")
    expect(result).toContain("| 買價 | 賣價 |")
    expect(result).toContain("0.000012 | 0.00001235 |")
  })

  it("uses placeholders for a quote missing bid/ask values within a shared table", () => {
    const result = formatMarketResults([
      { ...quote, prices: { ...quote.prices, bid: 97, ask: 98 } },
      quote,
    ])
    expect(result).toContain("| 成交量 | 買價 | 賣價 |")
    expect(result).toContain("239,424 | 97.00 | 98.00 |")
    expect(result).toContain("239,424 | — | — |")
  })

  it("escapes upstream names, source labels, and currency units", () => {
    const result = formatMarketResults([
      {
        ...quote,
        name: "A | **B**\n[link](https://example.test)",
        source: "source|test",
        prices: { currency: "TWD\nUSD" },
      },
    ])
    expect(result).toContain("**0050 A \\| \\*\\*B\\*\\* \\[link\\](https://example.test)**")
    expect(result).toContain("價格單位：TWD USD｜資料來源：source\\|test")
  })

  it("keeps currency tables intact alongside quote tables", () => {
    const currency = formatMarketTable("💱 Frankfurter USD/TWD", [["參考中價", "31.8 TWD"]])
    expect(formatMarketResults([quote, currency])).toContain(`\n\n${currency}`)
  })

  it("escapes Markdown and prevents values from adding currency table rows or columns", () => {
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
