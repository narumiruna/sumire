import { describe, expect, it, vi } from "vitest"
import { createCachedExchangeRateFetcher } from "../src/market-data/exchange-rates.js"
import { type MarketFetch, requestJson } from "../src/market-data/http.js"
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
    ["00500", "twse", "00500"],
    ["020000", "twse", "020000"],
    ["00980A", "twse", "00980A"],
    ["2881A", "twse", "2881A"],
    ["00679B", "twse", "00679B"],
    ["00631L", "twse", "00631L"],
    ["00980A.TW", "yahoo", "00980A.TW"],
    ["123A", "yahoo", "123A"],
    ["123456A", "yahoo", "123456A"],
    ["1234AB", "yahoo", "1234AB"],
    ["BTCUSDT", "max", "BTCUSDT"],
    ["ETH/TWD", "max", "ETH/TWD"],
    ["USD", "currency", "USD/TWD"],
    ["JPY/TWD", "currency", "JPY/TWD"],
    ["TWDJPY", "currency", "TWD/JPY"],
    ["TWD-JPY", "currency", "TWD/JPY"],
    ["USDJPY", "currency", "USD/JPY"],
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

  it("routes normalized letter-suffixed codes to TWSE and TPEX without querying Yahoo", async () => {
    const fetchImplementation: MarketFetch = vi.fn(async (input) => {
      const url = new URL(String(input))
      expect(url.hostname).toBe("mis.twse.com.tw")
      expect(url.searchParams.get("ex_ch")).toBe(
        "tse_00980A.tw|otc_00980A.tw|tse_2881A.tw|otc_2881A.tw",
      )
      return Response.json({
        msgArray: [
          { c: "00980A", n: "主動野村臺灣優選", z: "24.8" },
          { c: "2881A", n: "富邦特", z: "61.65" },
        ],
      })
    })

    const result = await queryMarketData("00980a, 2881a 00980A", { fetchImplementation })

    expect(result).toContain("主動野村臺灣優選 (00980A)")
    expect(result).toContain("富邦特 (2881A)")
    expect(result).toContain("資料來源: TWSE")
    expect(fetchImplementation).toHaveBeenCalledOnce()
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
      if (url.hostname === "api.frankfurter.dev") {
        expect(url.pathname).toBe("/v2/rate/USD/TWD")
        return Response.json({ base: "USD", date: "2026-09-22", quote: "TWD", rate: 31.8 })
      }
      if (url.pathname === "/api/v3/markets") {
        return Response.json([{ id: "btcusdt", base_unit: "btc", quote_unit: "usdt" }])
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
    expect(result).toContain("Frankfurter USD/TWD")
    expect(result).toContain("參考中價: 31.8 TWD")
    expect(result).toContain("資料日期: 2026年9月22日")
    expect(result).toContain("台灣銀行 USD/TWD")
    expect(result).toContain("即期中價: 31.8 TWD")
    expect(rateFetcher).toHaveBeenCalledOnce()
  })

  it("uses Frankfurter for cross rates and retains Bank of Taiwan for TWD pairs", async () => {
    const fetchImplementation: MarketFetch = vi.fn(async (input) => {
      const url = new URL(String(input))
      const [source, target] = url.pathname.split("/").slice(-2)
      const rates: Record<string, number> = { "TWD/JPY": 4.5, "USD/JPY": 140 }
      return Response.json({
        base: source,
        date: "2026-09-22",
        quote: target,
        rate: rates[`${source}/${target}`],
      })
    })
    const rateFetcher = vi.fn(async () => [
      {
        cashBuy: 0.19,
        cashSell: 0.26,
        exchange: "BANK_OF_TAIWAN" as const,
        fetchedAt,
        source: "JPY",
        spotBuy: 0.2,
        spotSell: 0.25,
        target: "TWD",
      },
    ])

    const result = await queryMarketData("TWDJPY USD/JPY", {
      fetchImplementation,
      rateFetcher,
    })

    expect(result).toContain("Frankfurter TWD/JPY")
    expect(result).toContain("Frankfurter USD/JPY")
    expect(result).toContain("參考中價: 140 JPY")
    expect(result).toContain("台灣銀行 TWD/JPY")
    expect(result).toContain("即期買入: 4 JPY")
    expect(result).toContain("即期賣出: 5 JPY")
    expect(result).not.toContain("台灣銀行 USD/JPY")
    expect(rateFetcher).toHaveBeenCalledOnce()
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it("rejects malformed Frankfurter data without querying Bank of Taiwan for a cross rate", async () => {
    const onError = vi.fn()
    const rateFetcher = vi.fn(async () => [])

    await expect(
      queryMarketData("USD/JPY", {
        fetchImplementation: async () =>
          Response.json({ base: "USD", date: "2026-09-22", quote: "JPY", rate: 0 }),
        onError,
        rateFetcher,
      }),
    ).rejects.toThrow("Unexpected Frankfurter exchange-rate response")
    expect(onError).toHaveBeenCalledWith("Frankfurter", expect.any(Error))
    expect(rateFetcher).not.toHaveBeenCalled()
  })

  it("keeps successful provider results when another provider fails", async () => {
    const onError = vi.fn()
    const fetchImplementation: MarketFetch = vi.fn(async (input) => {
      const url = new URL(String(input))
      if (url.hostname === "mis.twse.com.tw") {
        return Response.json({ msgArray: [{ c: "2330", n: "台積電", z: "1000" }] })
      }
      if (url.hostname === "api.frankfurter.dev") {
        return Response.json({ base: "USD", date: "2026-09-22", quote: "TWD", rate: 31.8 })
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
    expect(result).toContain("Frankfurter USD/TWD")
    expect(result).not.toContain("台灣銀行 USD/TWD")
    expect(onError).toHaveBeenCalledWith("Bank of Taiwan", expect.any(Error))
  })

  it.each([
    ["AAPL", "Yahoo Finance"],
    ["2330", "TWSE"],
    ["BTCUSDT", "MAX Exchange"],
  ])("propagates an HTTP failure for %s", async (input, provider) => {
    const onError = vi.fn()

    await expect(
      queryMarketData(input, {
        fetchImplementation: async () => new Response(null, { status: 503 }),
        onError,
      }),
    ).rejects.toThrow("Market-data request failed (503)")
    expect(onError).toHaveBeenCalledWith(provider, expect.any(Error))
  })

  it("propagates a Frankfurter failure when other providers succeed without data", async () => {
    const onError = vi.fn()

    await expect(
      queryMarketData("2330 USD", {
        fetchImplementation: async (input) => {
          const url = new URL(String(input))
          return url.hostname === "api.frankfurter.dev"
            ? new Response(null, { status: 503 })
            : Response.json({ msgArray: [] })
        },
        onError,
        rateFetcher: async () => [],
      }),
    ).rejects.toThrow("Market-data request failed (503)")
    expect(onError).toHaveBeenCalledWith("Frankfurter", expect.any(Error))
  })

  it("returns no data when providers succeed without matches", async () => {
    const onError = vi.fn()

    await expect(
      queryMarketData("2330", {
        fetchImplementation: async () => Response.json({ msgArray: [] }),
        onError,
      }),
    ).resolves.toBe("")
    expect(onError).not.toHaveBeenCalled()
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

  it("cancels a streamed response when its actual size exceeds the declared size", async () => {
    const cancel = vi.fn()
    const chunks = [new Uint8Array(2 * 1024 * 1024), new Uint8Array([1])]
    let index = 0
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            const chunk = chunks[index]
            index += 1
            if (chunk) controller.enqueue(chunk)
            else controller.close()
          },
          cancel,
        },
        { highWaterMark: 0 },
      ),
      { headers: { "content-length": "1" } },
    )

    await expect(requestJson("https://example.com", async () => response)).rejects.toThrow(
      "Market-data response is too large",
    )
    expect(cancel).toHaveBeenCalledOnce()
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
