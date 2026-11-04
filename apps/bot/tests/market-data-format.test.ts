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
  it("renders a three-column summary with names and full details outside the table", () => {
    expect(formatMarketResults([quote])).toBe(
      [
        "| 標的 | 現價 | 漲跌 |",
        "| --- | ---: | ---: |",
        "| **0050** | **97.78** | **-2.81%** |",
        "",
        "**0050 元大台灣50**",
        "",
        "開盤 101.55 · 最高 101.65 · 最低 97.70",
        "",
        "成交量 239,424",
        "",
        "TWD｜TWSE",
      ].join("\n"),
    )
  })

  it("uses explicit paragraph boundaries for every quote detail component", () => {
    const result = formatMarketResults([
      { ...quote, symbol: "VOO", name: "Vanguard S&P 500 ETF" },
      { ...quote, symbol: "TSM", name: "Taiwan Semiconductor Manufacturing Company Limited" },
    ])
    expect(result.split("\n\n").slice(1)).toEqual([
      "**VOO Vanguard S&P 500 ETF**",
      "開盤 101.55 · 最高 101.65 · 最低 97.70",
      "成交量 239,424",
      "**TSM Taiwan Semiconductor Manufacturing Company Limited**",
      "開盤 101.55 · 最高 101.65 · 最低 97.70",
      "成交量 239,424",
      "TWD｜TWSE",
    ])
  })

  it("omits absent detail paragraphs without collapsing remaining boundaries", () => {
    const result = formatMarketResults([{ ...quote, prices: { last: 0, volume: 0 } }])
    expect(result.split("\n\n").slice(1)).toEqual([
      "**0050 元大台灣50**",
      "成交量 0",
      "未提供｜TWSE",
    ])
    expect(result).toContain("| **0050** | **0.00** | — |")
    expect(result).not.toContain("開盤")
    expect(result).not.toContain("\n\n\n")
  })

  it("combines same-unit same-source quotes under one header and footer", () => {
    const second: MarketQuote = { ...quote, symbol: "2330", name: "台積電" }
    const result = formatMarketResults([quote, second])
    expect(result.match(/\| 標的 \|/gu)).toHaveLength(1)
    expect(result.match(/TWSE/gu)).toHaveLength(1)
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
    expect(result).toContain("TWD｜TWSE")
    expect(result).toContain("TWD｜Yahoo Finance")
    expect(result).toContain("USD｜TWSE")
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
    expect(result).toContain("| **TEST** | **0.00** | — |")
    expect(result).toContain("成交量 0")
    expect(result).not.toContain("開盤")
    expect(result).toContain("未提供")
    expect(formatMarketResults([])).toBe("")
  })

  it.each([
    [110, "+10.00%"],
    [100, "+0.00%"],
    [90, "-10.00%"],
  ])("preserves signed changes without width-consuming icons for price %s", (last, expected) => {
    expect(formatMarketResults([{ ...quote, prices: { last, changeFrom: 100 } }])).toContain(
      `**${expected}**`,
    )
  })

  it("retains crypto precision and moves bid/ask values outside the table", () => {
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
    expect(result).not.toContain("| 買價 |")
    expect(result).toContain("買價 0.000012 · 賣價 0.00001235")
  })

  it("omits missing bid/ask details without changing the summary columns", () => {
    const result = formatMarketResults([
      { ...quote, prices: { ...quote.prices, bid: 97, ask: 98 } },
      quote,
    ])
    expect(result).toContain("| 標的 | 現價 | 漲跌 |")
    expect(result).toContain("成交量 239,424 · 買價 97.00 · 賣價 98.00")
    expect(result.match(/買價/gu)).toHaveLength(1)
    expect(result.match(/成交量 239,424/gu)).toHaveLength(2)
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
    expect(result).toContain("TWD USD｜source\\|test")
  })

  it("keeps long VOO and TSM names out of the three-column summary", () => {
    const result = formatMarketResults([
      {
        symbol: "VOO",
        name: "Vanguard S&P 500 ETF",
        source: "Yahoo Finance",
        prices: { last: 693.54, changeFrom: 691.33, currency: "USD", open: 691.88, high: 695.9 },
      },
      {
        symbol: "TSM",
        name: "Taiwan Semiconductor Manufacturing Company Limited",
        source: "Yahoo Finance",
        prices: { last: 404.8, changeFrom: 398.62, currency: "USD", open: 404.99, high: 408.37 },
      },
    ])
    const table = result.split("\n").filter((line) => line.startsWith("|"))
    expect(table).toEqual([
      "| 標的 | 現價 | 漲跌 |",
      "| --- | ---: | ---: |",
      "| **VOO** | **693.54** | **+0.32%** |",
      "| **TSM** | **404.80** | **+1.55%** |",
    ])
    expect(table.every((line) => line.split("|").length === 5)).toBe(true)
    expect(result).toContain("**VOO Vanguard S&P 500 ETF**\n\n開盤 691.88 · 最高 695.90")
    expect(result).toContain(
      "**TSM Taiwan Semiconductor Manufacturing Company Limited**\n\n開盤 404.99 · 最高 408.37",
    )
    expect(result).not.toMatch(/🔺|🔻|⏸️/u)
  })

  it("preserves names even when no extra price details are available", () => {
    const result = formatMarketResults([{ ...quote, prices: { last: 97.78 } }])
    expect(result).toContain("| **0050** | **97.78** | — |")
    expect(result).toContain("**0050 元大台灣50**")
    expect(result).not.toContain("開盤")
    expect(result).not.toContain("成交量")
  })

  it("shows a single MAX source footer without a redundant detail heading", () => {
    const result = formatMarketResults([
      {
        symbol: "BTC/USDT",
        name: "MAX Exchange",
        source: "MAX Exchange",
        prices: {
          last: 65500,
          open: 64500,
          changeFrom: 64500,
          currency: "USDT",
          volume: 12.5,
          bid: 65000.1,
          ask: 65500.2,
        },
      },
    ])
    expect(result.match(/MAX Exchange/gu)).toHaveLength(1)
    expect(result.match(/\*\*BTC\/USDT\*\*/gu)).toHaveLength(1)
    expect(result).toContain("開盤 64,500.00")
    expect(result).toContain("成交量 12.5 · 買價 65,000.10 · 賣價 65,500.20")
    expect(result.endsWith("USDT｜MAX Exchange")).toBe(true)
  })

  it("keeps symbol headings for multiple MAX instruments while showing the source once", () => {
    const result = formatMarketResults([
      {
        symbol: "BTC/USDT",
        name: "MAX Exchange",
        source: "MAX Exchange",
        prices: { last: 65500, open: 64500, currency: "USDT" },
      },
      {
        symbol: "ETH/USDT",
        name: "MAX Exchange",
        source: "MAX Exchange",
        prices: { last: 3000, open: 2900, currency: "USDT" },
      },
    ])
    expect(result).toContain("**BTC/USDT**\n\n開盤 64,500.00")
    expect(result).toContain("**ETH/USDT**\n\n開盤 2,900.00")
    expect(result.match(/MAX Exchange/gu)).toHaveLength(1)
  })

  it("does not add an empty details block for a symbol-only quote", () => {
    expect(
      formatMarketResults([
        {
          name: "TEST",
          symbol: "TEST",
          source: "Yahoo Finance",
          prices: { last: 1 },
        },
      ]),
    ).toBe(
      [
        "| 標的 | 現價 | 漲跌 |",
        "| --- | ---: | ---: |",
        "| **TEST** | **1.00** | — |",
        "",
        "未提供｜Yahoo Finance",
      ].join("\n"),
    )
  })

  it("adds escaped source metadata only in a currency table footer", () => {
    const result = formatMarketTable("💱 USD/TWD", [["參考中價", "31.8 TWD"]], {
      currency: "TWD",
      source: "Provider|test\nsource",
    })
    expect(result).toBe(
      [
        "💱 USD/TWD",
        "",
        "| 項目 | 數值 |",
        "| --- | --- |",
        "| 參考中價 | 31.8 TWD |",
        "",
        "TWD｜Provider\\|test source",
      ].join("\n"),
    )
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
