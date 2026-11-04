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
const disclosure = "<details><summary>查看完整名稱與詳細報價</summary>"

describe("market quote tables", () => {
  it("puts the source first and preserves summary plus a collapsed detail table", () => {
    expect(formatMarketResults([quote])).toBe(
      [
        "**TWSE｜TWD**",
        "",
        "| 標的 | 現價 | 漲跌 |",
        "| --- | ---: | ---: |",
        "| **0050** | **97.78** | **-2.81%** |",
        "",
        disclosure,
        "",
        "| 標的 | 開盤 | 最高 | 最低 | 成交量 |",
        "| --- | ---: | ---: | ---: | ---: |",
        "| **0050 元大台灣50** | 101.55 | 101.65 | 97.70 | 239,424 |",
        "",
        "</details>",
      ].join("\n"),
    )
  })

  it("puts each full name and its values on one detail row", () => {
    const result = formatMarketResults([
      quote,
      {
        ...quote,
        symbol: "2330",
        name: "台積電",
        prices: { ...quote.prices, open: 2320, high: 2320, low: 2235, volume: 23680 },
      },
    ])
    const details = result.split(disclosure)[1] ?? ""
    expect(details).toContain("| **0050 元大台灣50** | 101.55 | 101.65 | 97.70 | 239,424 |")
    expect(details).toContain("| **2330 台積電** | 2,320.00 | 2,320.00 | 2,235.00 | 23,680 |")
    expect(details.match(/\| 標的 \| 開盤/gu)).toHaveLength(1)
  })

  it("uses missing-cell placeholders without inventing zeroes or extra paragraphs", () => {
    const result = formatMarketResults([{ ...quote, prices: { last: 0, volume: 0 } }])
    expect(result).toContain("| **0050** | **0.00** | — |")
    expect(result).toContain("| **0050 元大台灣50** | — | — | — | 0 |")
    expect(result.startsWith("**TWSE｜未提供**\n\n")).toBe(true)
    expect(result).not.toContain("\n\n\n")
    expect(formatMarketResults([])).toBe("")
  })

  it("keeps source and three-column summary visible, with details closed by default", () => {
    const result = formatMarketResults([quote, { ...quote, symbol: "2330", name: "台積電" }])
    const [visible, hidden] = result.split(disclosure)
    expect(visible?.startsWith("**TWSE｜TWD**\n\n")).toBe(true)
    expect(visible).toContain("| **0050** | **97.78** | **-2.81%** |")
    expect(visible).not.toContain("開盤")
    expect(visible).not.toContain("元大台灣50")
    expect(hidden).toContain("| 標的 | 開盤 | 最高 | 最低 | 成交量 |")
    expect(hidden?.split("</details>")[1]).toBe("")
    expect(result).not.toContain("<details open")
  })

  it("escapes upstream HTML so names cannot close or open disclosure blocks", () => {
    const result = formatMarketResults([
      { ...quote, name: "X </details><details open><summary>injected</summary>" },
    ])
    expect(result.match(/<details>/gu)).toHaveLength(1)
    expect(result.match(/<\/details>/gu)).toHaveLength(1)
    expect(result).not.toContain("<details open>")
    expect(result).not.toContain("<summary>injected</summary>")
    expect(result).toContain("\\</details\\>\\<details open\\>")
  })

  it("combines same-unit same-source quotes under one source heading", () => {
    const result = formatMarketResults([quote, { ...quote, symbol: "2330", name: "台積電" }])
    expect(result.match(/\| 標的 \| 現價/gu)).toHaveLength(1)
    expect(result.match(/\| 標的 \| 開盤/gu)).toHaveLength(1)
    expect(result.match(/TWSE/gu)).toHaveLength(1)
    expect(result.match(/<details>/gu)).toHaveLength(1)
  })

  it("keeps different currencies and sources in independently labeled groups", () => {
    const result = formatMarketResults([
      quote,
      { ...quote, source: "Yahoo Finance" },
      { ...quote, prices: { ...quote.prices, currency: "USD" } },
    ])
    for (const source of ["**TWSE｜TWD**", "**Yahoo Finance｜TWD**", "**TWSE｜USD**"]) {
      expect(result).toContain(`${source}\n\n| 標的 | 現價 | 漲跌 |`)
    }
    expect(result.match(/<details>/gu)).toHaveLength(3)
    expect(result.match(/<\/details>/gu)).toHaveLength(3)
  })

  it.each([
    [110, "+10.00%"],
    [100, "+0.00%"],
    [90, "-10.00%"],
  ])("preserves signed changes for price %s", (last, expected) => {
    expect(formatMarketResults([{ ...quote, prices: { last, changeFrom: 100 } }])).toContain(
      `**${expected}**`,
    )
  })

  it("preserves crypto precision and adds bid/ask columns only inside details", () => {
    const result = formatMarketResults([
      {
        symbol: "BTC/USDT",
        name: "MAX Exchange",
        source: "MAX Exchange",
        prices: {
          last: 0.00001234,
          bid: 0.000012,
          ask: 0.00001235,
          maximumFractionDigits: 8,
          currency: "USDT",
        },
      },
    ])
    const [visible, hidden] = result.split(disclosure)
    expect(visible).toContain("| **BTC/USDT** | **0.00001234** | — |")
    expect(visible).not.toContain("買價")
    expect(hidden).toContain("| 成交量 | 買價 | 賣價 |")
    expect(hidden).toContain("| **BTC/USDT** | — | — | — | — | 0.000012 | 0.00001235 |")
    expect(result.match(/MAX Exchange/gu)).toHaveLength(1)
  })

  it("aligns mixed bid/ask availability and preserves zero and fractional volume", () => {
    const result = formatMarketResults([
      { ...quote, prices: { ...quote.prices, volume: 12.5, bid: 97, ask: 98 } },
      { ...quote, symbol: "TEST", prices: { volume: 0, currency: "TWD" } },
    ])
    expect(result).toContain("12.5 | 97.00 | 98.00 |")
    expect(result).toContain("| **TEST 元大台灣50** | — | — | — | 0 | — | — |")
  })

  it("preserves a complete MAX quote in one detail-table row with the source only above", () => {
    const result = formatMarketResults([
      {
        symbol: "BTC/USDT",
        name: "MAX Exchange",
        source: "MAX Exchange",
        prices: {
          currency: "USDT",
          last: 65500,
          open: 64500,
          changeFrom: 64500,
          high: 66000,
          low: 64000,
          volume: 12.5,
          bid: 65000.1,
          ask: 65500.2,
          maximumFractionDigits: 8,
        },
      },
    ])
    expect(result.startsWith("**MAX Exchange｜USDT**\n\n")).toBe(true)
    expect(result).toContain("| **BTC/USDT** | **65,500.00** | **+1.55%** |")
    expect(result).toContain(
      "| **BTC/USDT** | 64,500.00 | 66,000.00 | 64,000.00 | 12.5 | 65,000.10 | 65,500.20 |",
    )
    expect(result.match(/MAX Exchange/gu)).toHaveLength(1)
    expect(result.endsWith("</details>")).toBe(true)
  })

  it("adds only an ask column when no bid is available in the group", () => {
    const result = formatMarketResults([{ ...quote, prices: { ...quote.prices, ask: 98 } }, quote])
    const body = result.split(disclosure)[1] ?? ""
    expect(body).toContain("| 標的 | 開盤 | 最高 | 最低 | 成交量 | 賣價 |")
    expect(body).not.toContain("買價")
    expect(body).toContain("239,424 | 98.00 |")
    expect(body).toContain("239,424 | — |")
    expect(
      body
        .split("\n")
        .filter((line) => line.startsWith("|"))
        .every((line) => line.split("|").length === 8),
    ).toBe(true)
  })

  it("escapes table delimiters and Markdown in names and source headings", () => {
    const result = formatMarketResults([
      {
        ...quote,
        name: "A | **B**\n[link](https://example.test)",
        source: "source|test",
        prices: { currency: "TWD\nUSD" },
      },
    ])
    expect(result).toContain(
      "| **0050 A \\| \\*\\*B\\*\\* \\[link\\](https://example.test)** | — | — | — | — |",
    )
    expect(result.startsWith("**source\\|test｜TWD USD**\n\n")).toBe(true)
  })

  it("keeps long VOO and TSM names out of the visible summary", () => {
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
    const [visible, hidden] = result.split(disclosure)
    expect(visible?.split("\n").filter((line) => line.startsWith("|"))).toEqual([
      "| 標的 | 現價 | 漲跌 |",
      "| --- | ---: | ---: |",
      "| **VOO** | **693.54** | **+0.32%** |",
      "| **TSM** | **404.80** | **+1.55%** |",
    ])
    expect(hidden).toContain("| **VOO Vanguard S&P 500 ETF** | 691.88 | 695.90 | — | — |")
    expect(hidden).toContain(
      "| **TSM Taiwan Semiconductor Manufacturing Company Limited** | 404.99 | 408.37 | — | — |",
    )
    expect(result).not.toMatch(/🔺|🔻|⏸️/u)
  })

  it("retains names even when no detailed numbers are available", () => {
    const result = formatMarketResults([{ ...quote, prices: { last: 97.78 } }])
    expect(result).toContain("| **0050 元大台灣50** | — | — | — | — |")
    expect(result).not.toContain("| 買價 |")
    expect(result).not.toContain("| 賣價 |")
  })

  it("does not repeat source names as MAX instrument names", () => {
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
    expect(result.startsWith("**MAX Exchange｜USDT**\n\n")).toBe(true)
    expect(result.match(/MAX Exchange/gu)).toHaveLength(1)
    expect(result).toContain("| **BTC/USDT** | 64,500.00 | — | — | — |")
    expect(result).toContain("| **ETH/USDT** | 2,900.00 | — | — | — |")
  })

  it("omits an empty disclosure for one or multiple symbol-only quotes", () => {
    const minimal: MarketQuote = {
      name: "TEST",
      symbol: "TEST",
      source: "Yahoo Finance",
      prices: { last: 1 },
    }
    expect(formatMarketResults([minimal])).toBe(
      [
        "**Yahoo Finance｜未提供**",
        "",
        "| 標的 | 現價 | 漲跌 |",
        "| --- | ---: | ---: |",
        "| **TEST** | **1.00** | — |",
      ].join("\n"),
    )
    expect(
      formatMarketResults([minimal, { ...minimal, name: "OTHER", symbol: "OTHER" }]),
    ).not.toContain("<details>")
  })

  it("puts escaped currency source metadata before the pair and table", () => {
    expect(
      formatMarketTable("💱 USD/TWD", [["參考中價", "31.8 TWD"]], {
        currency: "TWD",
        source: "Provider|test\nsource",
      }),
    ).toBe(
      [
        "**Provider\\|test source｜TWD**",
        "",
        "💱 USD/TWD",
        "",
        "| 項目 | 數值 |",
        "| --- | --- |",
        "| 參考中價 | 31.8 TWD |",
      ].join("\n"),
    )
  })

  it("keeps currency tables outside stock disclosures", () => {
    const currency = formatMarketTable("💱 USD/TWD", [["參考中價", "31.8 TWD"]], {
      currency: "TWD",
      source: "Frankfurter v2",
    })
    const result = formatMarketResults([quote, currency])
    expect(result).toContain(`</details>\n\n${currency}`)
    expect(currency).not.toContain("<details>")
  })

  it("keeps metadata optional and escapes currency-table cells", () => {
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
