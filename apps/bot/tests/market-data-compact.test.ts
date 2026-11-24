import { afterEach, describe, expect, it, vi } from "vitest"
import {
  formatMarketMessages,
  formatMarketResults,
  MarketDataOutputError,
  type MarketQuote,
  maxMarketMessageChars,
} from "../src/market-data/format.js"
import type { MarketFetch } from "../src/market-data/http.js"
import { queryMarketData, queryMarketDataMessages } from "../src/market-data/query.js"

const queriedAt = new Date("2026-11-23T14:15:00Z")
const disclosure = "<details><summary>詳細報價</summary>"
const quotes: MarketQuote[] = [
  {
    symbol: "NVDA",
    name: "NVIDIA Corporation",
    source: "Yahoo Finance",
    session: "pre",
    asOf: "2026-11-23T14:14:49Z",
    prices: { currency: "USD", last: 160, changeFrom: 156.86274509803923 },
  },
  {
    symbol: "TSM",
    name: "Taiwan Semiconductor Manufacturing",
    source: "Yahoo Finance",
    session: "pre",
    asOf: "2026-11-23T14:13:00Z",
    prices: { currency: "USD", last: 300, changeFrom: 297.029702970297 },
  },
  {
    symbol: "0050",
    name: "元大台灣50",
    source: "TWSE",
    prices: { currency: "TWD", last: 60, changeFrom: 59.70149253731344 },
  },
  {
    symbol: "2330",
    name: "台積電",
    source: "TWSE",
    prices: { currency: "TWD", last: 1000, changeFrom: 990.09900990099 },
  },
]

afterEach(() => vi.useRealTimers())

describe("compact multi-symbol market replies", () => {
  it("shows all four requested stocks before one query footer and one shared disclosure", () => {
    const result = formatMarketResults(quotes, queriedAt)
    const [visible, hidden] = result.split(disclosure)
    expect(visible).toBe(
      [
        "**Yahoo｜USD**",
        "",
        "| 標的 | 現價 | 漲跌 |",
        "| --- | ---: | ---: |",
        "| **NVDA** 盤前 | **160.00** | **+2.00%** |",
        "| **TSM** 盤前 | **300.00** | **+1.00%** |",
        "",
        "**TWSE｜TWD**",
        "",
        "| 標的 | 現價 | 漲跌 |",
        "| --- | ---: | ---: |",
        "| **0050** | **60.00** | **+0.50%** |",
        "| **2330** | **1,000.00** | **+1.00%** |",
        "",
        "查詢時間：2026-11-23 22:15（台灣）",
        "",
        "⚠ 報價可能延遲",
        "",
        "",
      ].join("\n"),
    )
    expect(result.match(/查詢時間/gu)).toHaveLength(1)
    expect(result.match(/⚠ 報價可能延遲/gu)).toHaveLength(1)
    expect(result.match(/<details>/gu)).toHaveLength(1)
    expect(result).not.toContain("行情時間")
    expect(result).not.toContain("14:14:49")
    expect(hidden).toContain("**Yahoo｜USD**")
    expect(hidden).toContain("**TWSE｜TWD**")
    expect(hidden).toContain("NVDA NVIDIA Corporation")
    expect(hidden).toContain("2330 台積電")
    expect(formatMarketMessages(quotes, queriedAt)).toEqual([result])
  })

  it("labels a lone detail table when another source has only a minimal summary", () => {
    const quote = quotes[0]
    if (!quote) throw new Error("fixture missing")
    const result = formatMarketResults([
      quote,
      { symbol: "MINIMAL", name: "MINIMAL", source: "TWSE", prices: { last: 1, currency: "TWD" } },
    ])
    const hidden = result.split(disclosure)[1] ?? ""
    expect(hidden).toContain("**Yahoo｜USD**")
    expect(hidden).not.toContain("MINIMAL")
  })

  it("does not hide regular/closing fallback status or invent an extended-hours label", () => {
    const quote = quotes[0]
    if (!quote) throw new Error("fixture missing")
    const result = formatMarketResults(
      [
        {
          ...quote,
          session: "regular",
          notice: "盤前／盤後資料暫不可用；顯示一般交易／收盤價格。",
        },
      ],
      queriedAt,
    )
    const [visible, hidden] = result.split(disclosure)
    expect(visible).toContain("**NVDA** 一般／收盤")
    expect(visible).not.toContain("**NVDA** 盤前")
    expect(visible).not.toContain("資料暫不可用")
    expect(hidden).toContain("資料暫不可用")
  })

  it("uses the Taiwan date at midnight and emits nothing for an empty result", () => {
    expect(formatMarketResults(quotes, new Date("2026-11-23T16:00:00Z"))).toContain(
      "查詢時間：2026-11-24 00:00（台灣）",
    )
    expect(formatMarketResults([], queriedAt)).toBe("")
    expect(formatMarketMessages([], queriedAt)).toEqual([])
  })

  it("includes the query footer in exact Unicode source-limit accounting", () => {
    const overhead = Array.from(formatMarketMessages(["x"], queriedAt)[0] ?? "").length - 1
    const text = "🌸".repeat(maxMarketMessageChars - overhead)
    const [message] = formatMarketMessages([text], queriedAt)
    expect(Array.from(message ?? "")).toHaveLength(maxMarketMessageChars)
    expect(() => formatMarketMessages([`${text}🌸`], queriedAt)).toThrow(MarketDataOutputError)
  })

  it("repeats one identical query time per complete native part, never per source or stock", () => {
    const quote = quotes[0]
    if (!quote) throw new Error("fixture missing")
    const results = Array.from({ length: 101 }, (_, index) => ({
      ...quote,
      symbol: `S${index}`,
    }))
    const messages = formatMarketMessages(results, queriedAt)
    expect(messages).toHaveLength(3)
    for (const message of messages) {
      expect(Array.from(message).length).toBeLessThanOrEqual(maxMarketMessageChars)
      expect(message.match(/查詢時間：2026-11-23 22:15（台灣）/gu)).toHaveLength(1)
      expect(message.match(/<details>/gu)).toHaveLength(1)
      expect(message.match(/<\/details>/gu)).toHaveLength(1)
    }
  })

  it.each([queryMarketData, queryMarketDataMessages])(
    "captures one query-start time before delayed providers finish (%s)",
    async (query) => {
      vi.useFakeTimers()
      vi.setSystemTime(queriedAt)
      let advanced = false
      const fetchImplementation: MarketFetch = async (input) => {
        const url = new URL(String(input))
        if (!advanced) {
          advanced = true
          vi.advanceTimersByTime(61_000)
        }
        if (url.hostname === "mis.twse.com.tw") {
          return Response.json({
            msgArray: [
              { c: "0050", n: "元大台灣50", z: "60", y: "59" },
              { c: "2330", n: "台積電", z: "1000", y: "990" },
            ],
          })
        }
        return Response.json({
          chart: {
            result: [
              {
                meta: {
                  symbol: url.pathname.split("/").at(-1),
                  currency: "USD",
                  regularMarketPrice: 160,
                  regularMarketTime: Date.parse("2026-11-20T21:00:01Z") / 1000,
                },
              },
            ],
          },
        })
      }
      const response = await query("NVDA TSM 0050 2330", { fetchImplementation })
      const result = Array.isArray(response) ? response.join("\n") : response
      expect(result.match(/查詢時間/gu)).toHaveLength(1)
      expect(result).toContain("查詢時間：2026-11-23 22:15（台灣）")
      expect(result).not.toContain("22:16")
      expect(result).not.toContain("行情時間")
      for (const symbol of ["NVDA", "TSM", "0050", "2330"]) expect(result).toContain(symbol)
      expect(result).toContain("**Yahoo｜USD**")
      expect(result).toContain("**TWSE｜TWD**")
    },
  )
})
