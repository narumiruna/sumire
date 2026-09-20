import { describe, expect, it } from "vitest"
import type { MarketFetch } from "../src/market-data/http.js"
import { queryYahooFinance } from "../src/market-data/yahoo-finance.js"

function quoteFetcher(
  quote: Record<string, unknown>,
  meta: Record<string, unknown> = { regularMarketPrice: 110 },
  withTimestamps = true,
): MarketFetch {
  return async () =>
    Response.json({
      chart: {
        result: [
          {
            meta: { symbol: "TEST", ...meta },
            ...(withTimestamps ? { timestamp: [1, 2, 3] } : {}),
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
    expect(results[0]).toContain("現價: 110")
    expect(results[0]).toContain("漲跌: 🔺 +10.00%")
    for (const label of ["開盤:", "最高:", "最低:", "成交量:"]) {
      expect(results[0]).not.toContain(label)
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

    expect(results[0]).toContain("漲跌: 🔺 +10.00%")
  })

  it("does not skip a missing previous close to calculate a multi-day change", async () => {
    const results = await queryYahooFinance(["TEST"], quoteFetcher({ close: [80, null, 110] }))

    expect(results[0]).toContain("現價: 110")
    expect(results[0]).not.toContain("漲跌:")
  })

  it.each([true, false])(
    "keeps short arrays aligned with the latest candle (timestamps present: %s)",
    async (withTimestamps) => {
      const quote = { close: [90, 100, 110], high: [95, 105], volume: [1_000, 2_000] }
      const results = await queryYahooFinance(
        ["TEST"],
        quoteFetcher(quote, { regularMarketPrice: 110 }, withTimestamps),
      )

      expect(results[0]).toContain("現價: 110")
      expect(results[0]).not.toContain("最高:")
      expect(results[0]).not.toContain("成交量:")
    },
  )

  it("uses the timestamp index even if all price arrays end before the latest candle", async () => {
    const results = await queryYahooFinance(
      ["TEST"],
      quoteFetcher({ close: [90, 100], open: [89, 99], high: [95, 105] }),
    )

    expect(results[0]).toContain("現價: 110")
    expect(results[0]).toContain("漲跌: 🔺 +10.00%")
    expect(results[0]).not.toContain("開盤:")
    expect(results[0]).not.toContain("最高:")
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

    expect(results[0]).toContain("現價: 110")
    expect(results[0]).toContain("最高: 115")
    expect(results[0]).toContain("最低: 99")
    expect(results[0]).toContain("開盤: 101")
    expect(results[0]).toContain("成交量: 0")
  })
})
