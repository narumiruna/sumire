import { describe, expect, it, vi } from "vitest"
import { createCachedExchangeRateFetcher } from "../src/market-data/exchange-rates.js"
import type { MarketFetch } from "../src/market-data/http.js"
import {
  classifyMarketTerm,
  MarketDataInputError,
  maxMarketTermLength,
  maxMarketTerms,
  parseMarketTerms,
  queryMarketData,
} from "../src/market-data/query.js"

const fetchedAt = "2026-09-20T12:00:00.000Z"

describe("market-data query", () => {
  it.each([
    ["AAPL", "yahoo", "AAPL"],
    ["BTC-USD", "yahoo", "BTC-USD"],
    ["2330", "twse", "2330"],
    ["BTCUSDT", "max", "BTCUSDT"],
    ["ETH/TWD", "max", "ETH/TWD"],
    ["USD", "currency", "USD"],
    ["JPY/TWD", "currency", "JPY"],
  ] as const)("classifies %s for %s", (term, provider, symbol) => {
    expect(classifyMarketTerm(term)).toEqual({ provider, symbol })
  })

  it("normalizes, deduplicates, and bounds query terms", () => {
    expect(parseMarketTerms(" aapl, 2330 AAPL ")).toEqual(["AAPL", "2330"])
    expect(() =>
      parseMarketTerms(Array.from({ length: maxMarketTerms + 1 }, (_, i) => `S${i}`).join(" ")),
    ).toThrow(MarketDataInputError)
    expect(() => parseMarketTerms("S".repeat(maxMarketTermLength + 1))).toThrow(
      MarketDataInputError,
    )
  })

  it("combines stock, Taiwan stock, crypto, and currency results", async () => {
    const fetchImplementation: MarketFetch = vi.fn(async (input) => {
      const url = new URL(String(input))
      if (url.hostname === "query1.finance.yahoo.com") {
        return Response.json({
          chart: {
            error: null,
            result: [
              {
                indicators: {
                  quote: [
                    {
                      close: [190, 195.25],
                      high: [192, 197],
                      low: [188, 193],
                      open: [189, 194],
                      volume: [1_000, 2_000],
                    },
                  ],
                },
                meta: {
                  chartPreviousClose: 190,
                  currency: "USD",
                  regularMarketPrice: 195.25,
                  shortName: "Apple Inc.",
                  symbol: "AAPL",
                },
              },
            ],
          },
        })
      }
      if (url.hostname === "mis.twse.com.tw") {
        expect(url.searchParams.get("ex_ch")).toContain("tse_2330.tw")
        return Response.json({
          msgArray: [
            {
              a: "1002_1003_",
              b: "1000_999_",
              c: "2330",
              h: "1010",
              l: "995",
              n: "台積電",
              o: "1000",
              v: "12345",
              y: "990",
              z: "1005",
            },
          ],
        })
      }
      if (url.pathname === "/api/v3/currencies") {
        return Response.json([
          { currency: "btc", type: "crypto" },
          { currency: "usdt", type: "crypto" },
        ])
      }
      if (url.pathname === "/api/v3/ticker") {
        expect(url.searchParams.get("market")).toBe("btcusdt")
        return Response.json({
          buy: "65000.1",
          high: "66000",
          last: "65500",
          low: "64000",
          open: "64500",
          sell: "65500.2",
          vol: "12.5",
        })
      }
      return new Response(null, { status: 404 })
    })
    const rateFetcher = vi.fn(async () => [
      {
        cashBuy: 31.5,
        cashSell: 32.1,
        exchange: "BANK_OF_TAIWAN" as const,
        fetchedAt,
        source: "USD",
        spotBuy: 31.75,
        spotSell: 31.85,
        target: "TWD",
      },
    ])

    const result = await queryMarketData("AAPL 2330 BTCUSDT USD", {
      fetchImplementation,
      rateFetcher,
    })

    expect(result).toContain("Apple Inc. (AAPL)")
    expect(result).toContain("現價: 195.25 USD")
    expect(result).toContain("台積電 (2330)")
    expect(result).toContain("MAX Exchange BTC/USDT")
    expect(result).toContain("買價: 65,000.1 USDT")
    expect(result).toContain("台灣銀行 USD/TWD")
    expect(result).toContain("即期中價: 31.8 TWD")
    expect(rateFetcher).toHaveBeenCalledOnce()
  })

  it("keeps successful provider results when another provider fails", async () => {
    const onError = vi.fn()
    const fetchImplementation: MarketFetch = vi.fn(async (input) => {
      const url = new URL(String(input))
      if (url.hostname === "mis.twse.com.tw") {
        return Response.json({ msgArray: [{ c: "2330", n: "台積電", z: "1000" }] })
      }
      return new Response(null, { status: 503 })
    })

    const result = await queryMarketData("2330 USD", {
      fetchImplementation,
      onError,
      rateFetcher: async () => {
        throw new Error("rate service unavailable")
      },
    })

    expect(result).toContain("台積電 (2330)")
    expect(result).not.toContain("USD/TWD")
    expect(onError).toHaveBeenCalledWith("Bank of Taiwan", expect.any(Error))
  })

  it("coalesces and caches Bank of Taiwan rate requests", async () => {
    let now = 1_000
    const rates = [
      {
        exchange: "BANK_OF_TAIWAN" as const,
        fetchedAt,
        source: "USD",
        spotBuy: 31.75,
        spotSell: 31.85,
        target: "TWD",
      },
    ]
    const fetcher = vi.fn(async () => rates)
    const cached = createCachedExchangeRateFetcher(fetcher, { now: () => now, ttlMs: 100 })

    await Promise.all([cached(), cached()])
    await cached()
    expect(fetcher).toHaveBeenCalledOnce()

    now += 101
    await cached()
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it("does not render malformed Yahoo values as zero", async () => {
    const fetchImplementation: MarketFetch = vi.fn(async () =>
      Response.json({
        chart: {
          result: [
            {
              indicators: { quote: [{ close: [null], high: [null], low: [null], open: [null] }] },
              meta: { regularMarketPrice: null, symbol: "BAD" },
            },
          ],
        },
      }),
    )

    await expect(queryMarketData("BAD", { fetchImplementation })).resolves.toBe("")
  })
})
