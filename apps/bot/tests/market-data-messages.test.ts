import { describe, expect, it } from "vitest"
import {
  formatMarketMessages,
  formatMarketResults,
  MarketDataOutputError,
  type MarketQuote,
  maxMarketMessageChars,
  maxMarketReplies,
} from "../src/market-data/format.js"

const quote: MarketQuote = {
  symbol: "0050",
  name: "元大台灣50",
  source: "TWSE",
  prices: { last: 97.78, open: 101.55, high: 101.65, low: 97.7, volume: 239424, currency: "TWD" },
}

function completeMessages(messages: string[]) {
  for (const text of messages) {
    expect(Array.from(text).length).toBeLessThanOrEqual(maxMarketMessageChars)
    expect(text.match(/<details>/gu)?.length ?? 0).toBe(text.match(/<\/details>/gu)?.length ?? 0)
    expect(text).not.toContain("<details open")
  }
}

describe("native market message batching", () => {
  it("keeps ordinary multi-source quotes and currency tables in one message", () => {
    const results = [
      quote,
      { ...quote, source: "Yahoo Finance", prices: { ...quote.prices, currency: "USD" } },
      "匯率表",
    ]
    expect(formatMarketMessages(results)).toEqual([formatMarketResults(results)])
    expect(formatMarketMessages([])).toEqual([])
  })

  it("splits large groups at instrument boundaries with complete tables and disclosures", () => {
    const quotes = Array.from({ length: 10 }, (_, index) => ({
      ...quote,
      symbol: `S${index}`,
      name: `${index}${"長名稱🌸".repeat(800)}`,
    }))
    const messages = formatMarketMessages(quotes)
    expect(messages.length).toBeGreaterThan(1)
    completeMessages(messages)
    const combined = messages.join("\n\n")
    for (const item of quotes) {
      expect(combined.split(`**${item.symbol}**`)).toHaveLength(2)
      expect(combined.split(`**${item.symbol} ${item.name}**`)).toHaveLength(2)
    }
    for (const text of messages) {
      expect(text.startsWith("**TWSE｜TWD**\n\n")).toBe(true)
      expect(text).toContain("| 標的 | 現價 | 漲跌 |")
      expect(text).toContain("| 標的 | 開盤 | 最高 | 最低 | 成交量 |")
    }
  })

  it("counts astral Unicode code points at the conservative native source limit", () => {
    const text = "🌸".repeat(maxMarketMessageChars)
    expect(formatMarketMessages([text])).toEqual([text])
    expect(() => formatMarketMessages([`${text}🌸`])).toThrow(MarketDataOutputError)
  })

  it("refuses a single oversized instrument without truncating names or markup", () => {
    expect(() =>
      formatMarketMessages([{ ...quote, name: "字".repeat(maxMarketMessageChars) }]),
    ).toThrow(MarketDataOutputError)
  })

  it("starts a new message before combined complete source groups exceed the limit", () => {
    const items = ["甲".repeat(10000), "乙".repeat(10000)]
    expect(formatMarketMessages(items)).toEqual(items)
  })

  it("bounds quote rows per message even for abnormally large provider batches", () => {
    const quotes = Array.from({ length: 101 }, (_, index) => ({ ...quote, symbol: `S${index}` }))
    const messages = formatMarketMessages(quotes)
    expect(messages).toHaveLength(3)
    completeMessages(messages)
    expect(messages.map((text) => text.match(/\| \*\*S\d+\*\* \|/gu)?.length)).toEqual([50, 50, 1])
  })

  it("counts source-section and quote-row budgets across groups", () => {
    expect(
      formatMarketMessages(Array.from({ length: 21 }, (_, index) => `匯率 ${index}`)).map(
        (text) => text.split("\n\n").length,
      ),
    ).toEqual([10, 10, 1])
    const results = Array.from({ length: 51 }, (_, index) => ({
      ...quote,
      symbol: `S${index}`,
      source: index < 26 ? "TWSE" : "Yahoo Finance",
    }))
    expect(formatMarketMessages(results)).toHaveLength(2)
  })
  it("refuses an excessive number of native parts before transport", () => {
    expect(() =>
      formatMarketMessages(Array.from({ length: maxMarketReplies * 10 + 1 }, () => "rate")),
    ).toThrow(MarketDataOutputError)
  })
})
