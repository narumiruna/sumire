import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { MarketFetch } from "../src/market-data/http.js"
import { queryMarketData } from "../src/market-data/query.js"
import { queryYahooFinance } from "../src/market-data/yahoo-finance.js"

const seconds = (date: string) => Date.parse(date) / 1_000
const pre = { start: seconds("2026-11-23T09:00:00Z"), end: seconds("2026-11-23T14:30:00Z") }
const regular = { start: pre.end, end: seconds("2026-11-23T21:00:00Z") }
const post = { start: regular.end, end: seconds("2026-11-24T01:00:00Z") }
const priceTime = seconds("2026-11-23T14:15:49Z")
const meta = {
  symbol: "NVDA",
  shortName: "NVIDIA Corporation",
  currency: "USD",
  priceHint: 2,
  regularMarketPrice: 125.53,
  regularMarketTime: seconds("2026-11-20T21:00:01Z"),
  currentTradingPeriod: { pre, regular, post },
}

function fetcher(
  options: {
    meta?: Record<string, unknown>
    timestamps?: unknown[]
    closes?: unknown[]
    status?: number
    empty?: boolean
    advanceMs?: number
  } = {},
) {
  return vi.fn<MarketFetch>(async (input) => {
    const url = new URL(String(input))
    const intraday = url.searchParams.get("interval") === "1m"
    if (intraday) {
      if (options.advanceMs) vi.advanceTimersByTime(options.advanceMs)
      expect(url.searchParams.get("includePrePost")).toBe("true")
      expect(url.searchParams.get("range")).toBe("1d")
      if (options.status) return new Response(null, { status: options.status })
    } else {
      expect(url.searchParams.get("interval")).toBe("1d")
      expect(url.searchParams.get("range")).toBe("5d")
    }
    return Response.json({
      chart: {
        result:
          intraday && options.empty
            ? null
            : [
                {
                  meta: { ...meta, ...options.meta },
                  timestamp: intraday ? (options.timestamps ?? [priceTime]) : [1, 2],
                  indicators: {
                    quote: [
                      {
                        close: intraday ? (options.closes ?? [161.76]) : [145.98, 125.53],
                        open: [140, 144],
                        high: [150, 146],
                        low: [130, 124],
                        volume: [100, 200],
                      },
                    ],
                  },
                },
              ],
      },
    })
  })
}

describe("Yahoo extended-hours quotes", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-23T14:15:50Z"))
  })
  afterEach(() => vi.useRealTimers())

  it("selects the latest premarket point, not the regular close or five-day reference", async () => {
    const request = fetcher()
    const [quote] = await queryYahooFinance(["NVDA"], request)
    expect(request).toHaveBeenCalledTimes(2)
    expect(quote).toMatchObject({
      session: "pre",
      asOf: "2026-11-23T14:15:49.000Z",
      prices: { last: 161.76, changeFrom: 125.53, currency: "USD" },
    })
    for (const field of ["open", "high", "low", "volume"] as const) {
      expect(quote?.prices[field]).toBeUndefined()
    }
    expect(quote?.notice).toContain("可能延遲")
    expect(quote?.notice).toContain("最近一般交易收盤價")
  })

  it("uses today's regular close for postmarket, including a closing print one second after 16:00", async () => {
    vi.setSystemTime(new Date("2026-11-23T22:00:00Z"))
    const [quote] = await queryYahooFinance(
      ["NVDA"],
      fetcher({
        meta: { regularMarketTime: regular.end + 1 },
        timestamps: [seconds("2026-11-23T21:59:59Z")],
        closes: [129],
      }),
    )
    expect(quote).toMatchObject({
      session: "post",
      asOf: "2026-11-23T21:59:59.000Z",
      prices: { last: 129, changeFrom: 125.53 },
    })
  })

  it("does not use a previous day's regular close as today's postmarket baseline", async () => {
    vi.setSystemTime(new Date("2026-11-23T22:00:00Z"))
    const [quote] = await queryYahooFinance(
      ["NVDA"],
      fetcher({ timestamps: [seconds("2026-11-23T21:59:59Z")] }),
    )
    expect(quote?.session).toBe("post")
    expect(quote?.prices.changeFrom).toBeUndefined()
  })

  it.each([undefined, priceTime + 1, Number.NaN])(
    "omits a percentage when the regular-close timestamp is missing or not before premarket (%s)",
    async (regularMarketTime) => {
      const [quote] = await queryYahooFinance(["NVDA"], fetcher({ meta: { regularMarketTime } }))
      expect(quote?.session).toBe("pre")
      expect(quote?.prices.changeFrom).toBeUndefined()
    },
  )

  it("does not use an older daily candle as the extended-hours percentage baseline", async () => {
    const [quote] = await queryYahooFinance(
      ["NVDA"],
      fetcher({ meta: { regularMarketPrice: undefined } }),
    )
    expect(quote?.prices.last).toBe(161.76)
    expect(quote?.prices.changeFrom).toBeUndefined()
  })

  it.each([
    { timestamps: [pre.start - 1] },
    { timestamps: [pre.end] },
    { timestamps: [priceTime + 2] },
    { timestamps: [null] },
    { timestamps: [] },
    { timestamps: [priceTime - 60, priceTime], closes: [160, null] },
    { timestamps: [priceTime - 60, priceTime], closes: [160] },
    { closes: [0] },
    { closes: [-1] },
    { closes: ["invalid"] },
    { empty: true },
    { status: 429 },
    { status: 503 },
  ])(
    "falls back explicitly without backfilling invalid, stale-session or failed data: %j",
    async (options) => {
      const [quote] = await queryYahooFinance(["NVDA"], fetcher(options))
      expect(quote).toMatchObject({
        session: "regular",
        asOf: "2026-11-20T21:00:01.000Z",
        prices: { last: 125.53, volume: 200 },
      })
      expect(quote?.notice).toContain("資料暫不可用")
      expect(quote?.notice).toContain("顯示一般交易／收盤價格")
    },
  )

  it("accepts a new point produced while the intraday HTTP request was in flight", async () => {
    const [quote] = await queryYahooFinance(
      ["NVDA"],
      fetcher({ advanceMs: 2_000, timestamps: [priceTime + 2] }),
    )
    expect(quote?.session).toBe("pre")
    expect(quote?.asOf).toBe("2026-11-23T14:15:51.000Z")
  })

  it("does not return a premarket quote after the request crosses the session boundary", async () => {
    vi.setSystemTime(new Date("2026-11-23T14:29:59Z"))
    const [quote] = await queryYahooFinance(
      ["NVDA"],
      fetcher({ advanceMs: 2_000, timestamps: [pre.end - 1] }),
    )
    expect(quote?.session).toBe("regular")
    expect(quote?.notice).toContain("資料暫不可用")
  })

  it("keeps a delayed point's actual timestamp rather than substituting request time", async () => {
    const timestamp = priceTime - 900
    const [quote] = await queryYahooFinance(["NVDA"], fetcher({ timestamps: [timestamp] }))
    expect(quote?.asOf).toBe(new Date(timestamp * 1_000).toISOString())
    expect(quote?.notice).toContain("非保證即時")
  })

  it.each(["2026-11-23T14:30:00Z", "2026-11-24T01:00:00Z", "2026-11-21T14:00:00Z"])(
    "does not fetch or mislabel extended data outside an explicit active period: %s",
    async (now) => {
      vi.setSystemTime(new Date(now))
      const request = fetcher()
      const [quote] = await queryYahooFinance(["NVDA"], request)
      expect(request).toHaveBeenCalledOnce()
      expect(quote?.session).toBe("regular")
      expect(quote?.prices.last).toBe(125.53)
    },
  )

  it.each([undefined, {}, { pre: { start: pre.start, end: pre.start } }])(
    "does not invent trading sessions when the provider supplies no valid boundaries: %j",
    async (currentTradingPeriod) => {
      const request = fetcher({ meta: { currentTradingPeriod } })
      await queryYahooFinance(["BTC-USD"], request)
      expect(request).toHaveBeenCalledOnce()
    },
  )

  it("uses provider boundaries during daylight saving time without hardcoded UTC offsets", async () => {
    vi.setSystemTime(new Date("2026-07-20T12:15:50Z"))
    const [quote] = await queryYahooFinance(
      ["NVDA"],
      fetcher({
        meta: {
          regularMarketTime: seconds("2026-07-17T20:00:00Z"),
          currentTradingPeriod: {
            pre: { start: seconds("2026-07-20T08:00:00Z"), end: seconds("2026-07-20T13:30:00Z") },
          },
        },
        timestamps: [seconds("2026-07-20T12:15:49Z")],
      }),
    )
    expect(quote?.session).toBe("pre")
    expect(quote?.asOf).toBe("2026-07-20T12:15:49.000Z")
  })

  it("renders /t NVDA with a visible session, actual Taiwan timestamp and delay disclosure", async () => {
    const result = await queryMarketData("NVDA", { fetchImplementation: fetcher() })
    expect(result).toContain("**Yahoo Finance｜USD**")
    expect(result).toContain("| **NVDA** | **161.76** | **+28.86%** |")
    expect(result).toContain("NVDA：盤前｜行情時間（台灣）：2026-11-23 22:15:49")
    expect(result).toContain("非保證即時行情")
    expect(result).not.toContain("| 144.00 | 146.00 | 124.00 | 200 |")
  })
})
