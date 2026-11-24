import { describe, expect, it } from "vitest"
import { formatMarketResults } from "../src/market-data/format.js"
import type { MarketFetch } from "../src/market-data/http.js"
import { queryYahooFinance } from "../src/market-data/yahoo-finance.js"

function quoteFetcher(
  quote: Record<string, unknown>,
  meta: Record<string, unknown> = { regularMarketPrice: 110 },
  timestamps: boolean | readonly number[] = true,
): MarketFetch {
  return async () =>
    Response.json({
      chart: {
        result: [
          {
            meta: { symbol: "TEST", ...meta },
            ...(timestamps ? { timestamp: timestamps === true ? [1, 2, 3] : timestamps } : {}),
            indicators: { quote: [quote] },
          },
        ],
      },
    })
}

describe("Yahoo candle alignment", () => {
  it("does not backfill missing latest fields from an older candle", async () => {
    const results = await queryYahooFinance(
      ["TEST"],
      quoteFetcher({
        close: [90, 100, null],
        high: [95, 105, null],
        low: [85, 95, null],
        open: [90, 100, null],
        volume: [1_000, 2_000, null],
      }),
    )

    expect(results).toHaveLength(1)
    expect(results[0]?.prices.last).toBe(110)
    expect(results[0]?.prices.changeFrom).toBe(100)
    for (const field of ["open", "high", "low", "volume"] as const) {
      expect(results[0]?.prices[field]).toBeUndefined()
    }
  })

  it("does not use an old close when the current price and latest close are missing", async () => {
    await expect(
      queryYahooFinance(["TEST"], quoteFetcher({ close: [90, 100, null] }, {})),
    ).resolves.toEqual([])
  })

  it("uses previous-close metadata when the immediately previous candle is missing", async () => {
    const results = await queryYahooFinance(
      ["TEST"],
      quoteFetcher(
        { close: [80, null, 110] },
        { regularMarketPrice: 110, previousClose: 100, chartPreviousClose: 80 },
      ),
    )

    expect(results[0]?.prices.changeFrom).toBe(100)
  })

  it("does not skip a missing previous close to calculate a multi-day change", async () => {
    const results = await queryYahooFinance(["TEST"], quoteFetcher({ close: [80, null, 110] }))

    expect(results[0]?.prices.last).toBe(110)
    expect(results[0]?.prices.changeFrom).toBeUndefined()
  })

  it.each([true, false])(
    "keeps short arrays aligned with the latest candle (timestamps present: %s)",
    async (withTimestamps) => {
      const quote = { close: [90, 100, 110], high: [95, 105], volume: [1_000, 2_000] }
      const results = await queryYahooFinance(
        ["TEST"],
        quoteFetcher(quote, { regularMarketPrice: 110 }, withTimestamps),
      )

      expect(results[0]?.prices.last).toBe(110)
      expect(results[0]?.prices.high).toBeUndefined()
      expect(results[0]?.prices.volume).toBeUndefined()
    },
  )

  it("uses the timestamp index even if all price arrays end before the latest candle", async () => {
    const results = await queryYahooFinance(
      ["TEST"],
      quoteFetcher({ close: [90, 100], open: [89, 99], high: [95, 105] }),
    )

    expect(results[0]?.prices.last).toBe(110)
    expect(results[0]?.prices.changeFrom).toBe(100)
    expect(results[0]?.prices.open).toBeUndefined()
    expect(results[0]?.prices.high).toBeUndefined()
  })

  it("retains valid latest values including zero without filtering array positions", async () => {
    const results = await queryYahooFinance(
      ["TEST"],
      quoteFetcher(
        {
          close: [null, 100, 110],
          high: [null, null, 115],
          low: [null, null, 99],
          open: [null, null, 101],
          volume: [null, null, 0],
        },
        {},
      ),
    )

    expect(results[0]?.prices.last).toBe(110)
    expect(results[0]?.prices.high).toBe(115)
    expect(results[0]?.prices.low).toBe(99)
    expect(results[0]?.prices.open).toBe(101)
    expect(results[0]?.prices.volume).toBe(0)
  })
})

describe("Yahoo previous-close baseline date alignment", () => {
  const timestamp = (date: string) => Date.parse(date) / 1_000
  const dailyTimes = ["2026-11-19T14:30:00Z", "2026-11-20T14:30:00Z"].map(timestamp)
  const meta = {
    regularMarketPrice: 110,
    regularMarketTime: timestamp("2026-11-23T15:00:00Z"),
    exchangeTimezoneName: "America/New_York",
    previousClose: 100,
    chartPreviousClose: 90,
  }

  it.each([undefined, 90])(
    "prefers the stale daily close over metadata (previousClose: %s)",
    async (previousClose) => {
      const results = await queryYahooFinance(
        ["TEST"],
        quoteFetcher({ close: [90, 100] }, { ...meta, previousClose }, dailyTimes),
      )

      expect(results[0]?.prices.changeFrom).toBe(100)
      expect(results[0]?.regular?.prices.changeFrom).toBe(100)
      const formatted = formatMarketResults(results)
      expect(formatted).toContain("+10.00%")
      expect(formatted).not.toContain("+22.22%")
      expect(formatted).toContain("前一交易日收盤價 100.00")
    },
  )

  it.each([undefined, null])(
    "uses the preceding candle when last falls back to a daily close (regularMarketPrice: %s)",
    async (regularMarketPrice) => {
      const results = await queryYahooFinance(
        ["TEST"],
        quoteFetcher({ close: [90, 100] }, { ...meta, regularMarketPrice }, dailyTimes),
      )

      expect(results[0]?.prices).toMatchObject({ last: 100, changeFrom: 90 })
      expect(results[0]?.regular?.prices.changeFrom).toBe(90)
      expect(results[0]?.asOf).toBeUndefined()
      const formatted = formatMarketResults(results)
      expect(formatted).toContain("+11.11%")
      expect(formatted).not.toContain("0.00%")
      expect(formatted).toContain("前一交易日收盤價 90.00")
    },
  )

  it("does not skip a missing preceding close when last falls back to a stale daily close", async () => {
    const [quote] = await queryYahooFinance(
      ["TEST"],
      quoteFetcher(
        { close: [80, null, 100] },
        {
          ...meta,
          regularMarketPrice: undefined,
          previousClose: undefined,
          chartPreviousClose: undefined,
        },
        [timestamp("2026-11-18T14:30:00Z"), ...dailyTimes],
      ),
    )

    expect(quote?.prices.last).toBe(100)
    expect(quote?.prices.changeFrom).toBeUndefined()
  })

  it("uses the preceding candle when the latest candle matches the quote date", async () => {
    const [quote] = await queryYahooFinance(
      ["TEST"],
      quoteFetcher({ close: [90, 100, 110] }, { ...meta, previousClose: 80 }, [
        ...dailyTimes,
        timestamp("2026-11-23T14:30:00Z"),
      ]),
    )

    expect(quote?.prices.changeFrom).toBe(100)
  })

  it("does not mistake a UTC date rollover for a new exchange trading date", async () => {
    const [quote] = await queryYahooFinance(
      ["TEST"],
      quoteFetcher(
        { close: [100, 110] },
        { ...meta, regularMarketTime: timestamp("2026-11-24T00:30:00Z") },
        [timestamp("2026-11-20T14:30:00Z"), timestamp("2026-11-23T23:30:00Z")],
      ),
    )

    expect(quote?.prices.changeFrom).toBe(100)
  })

  it.each([
    { name: "invalid timezone", overrides: { exchangeTimezoneName: "invalid" }, times: dailyTimes },
    { name: "missing quote time", overrides: { regularMarketTime: undefined }, times: dailyTimes },
    { name: "missing candle time", overrides: {}, times: [] },
    { name: "future candle date", overrides: {}, times: [timestamp("2026-11-24T14:30:00Z")] },
  ])("keeps the metadata baseline for $name", async ({ overrides, times }) => {
    const [quote] = await queryYahooFinance(
      ["TEST"],
      quoteFetcher({ close: [200, 200] }, { ...meta, ...overrides }, times),
    )

    expect(quote?.prices.changeFrom).toBe(100)
  })

  it.each([100, undefined])(
    "retains metadata fallbacks if the stale close is missing (previousClose: %s)",
    async (previousClose) => {
      const [quote] = await queryYahooFinance(
        ["TEST"],
        quoteFetcher({ close: [80, null] }, { ...meta, previousClose }, dailyTimes),
      )

      expect(quote?.prices.changeFrom).toBe(previousClose ?? 90)
    },
  )
})

describe("Yahoo daily statistics date alignment", () => {
  const timestamp = (date: string) => Date.parse(date) / 1_000
  const request =
    (candle: string, regular: string, timezone = "America/New_York"): MarketFetch =>
    async () =>
      Response.json({
        chart: {
          result: [
            {
              meta: {
                symbol: "TEST",
                regularMarketPrice: 110,
                previousClose: 100,
                regularMarketTime: timestamp(regular),
                exchangeTimezoneName: timezone,
              },
              timestamp: [timestamp(candle)],
              indicators: {
                quote: [{ close: [110], open: [101], high: [115], low: [99], volume: [0] }],
              },
            },
          ],
        },
      })

  it("retains same-trading-date statistics and zero volume", async () => {
    const [quote] = await queryYahooFinance(
      ["TEST"],
      request("2026-11-23T14:30:00Z", "2026-11-23T21:00:01Z"),
    )
    expect(quote?.regular?.prices).toMatchObject({ open: 101, high: 115, low: 99, volume: 0 })
  })

  it("does not attach yesterday's daily candle to today's quote", async () => {
    const [quote] = await queryYahooFinance(
      ["TEST"],
      request("2026-11-20T14:30:00Z", "2026-11-23T15:00:00Z"),
    )
    expect(quote?.prices.last).toBe(110)
    for (const field of ["open", "high", "low", "volume"] as const) {
      expect(quote?.regular?.prices[field]).toBeUndefined()
    }
  })

  it("compares exchange dates rather than UTC dates", async () => {
    const [quote] = await queryYahooFinance(
      ["TEST"],
      request("2026-11-23T23:30:00Z", "2026-11-24T00:30:00Z"),
    )
    expect(quote?.regular?.prices.volume).toBe(0)
  })

  it("fails closed for invalid provider timezones", async () => {
    const [quote] = await queryYahooFinance(
      ["TEST"],
      request("2026-11-23T14:30:00Z", "2026-11-23T21:00:01Z", "invalid"),
    )
    expect(quote?.regular?.prices.open).toBeUndefined()
  })
})
