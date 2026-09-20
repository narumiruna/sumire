import { describe, expect, it, vi } from "vitest"
import type { MarketFetch } from "../src/market-data/http.js"
import { queryMaxExchange } from "../src/market-data/max-exchange.js"
import { queryMarketData } from "../src/market-data/query.js"
import { queryYahooFinance } from "../src/market-data/yahoo-finance.js"

function createProviderFetch() {
  return vi.fn<MarketFetch>(async (input) => {
    const url = new URL(String(input))
    if (url.pathname === "/api/v3/markets") {
      return Response.json([
        { id: "btcusdt", base_unit: "btc", quote_unit: "usdt" },
        { id: "ethusdt", base_unit: "eth", quote_unit: "usdt" },
        { id: "ltcusdt", base_unit: "ltc", quote_unit: "usdt" },
      ])
    }
    if (url.pathname === "/api/v3/ticker") {
      return url.searchParams.get("market") === "btcusdt"
        ? Response.json({ last: "65000" })
        : new Response(null, { status: 503 })
    }
    if (url.hostname === "query1.finance.yahoo.com") {
      const symbol = decodeURIComponent(url.pathname.split("/").at(-1) ?? "")
      if (symbol.startsWith("FAILED")) return new Response(null, { status: 503 })
      if (symbol.startsWith("EMPTY") || symbol === "NOTAREALUSDT") {
        return Response.json({ chart: { result: [] } })
      }
      return Response.json({
        chart: { result: [{ meta: { regularMarketPrice: 50, symbol } }] },
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  })
}

describe.each([
  {
    provider: "MAX Exchange",
    query: queryMaxExchange,
    empty: "NOTAREALUSDT",
    success: "BTCUSDT",
    failure: "ETHUSDT",
  },
  {
    provider: "Yahoo Finance",
    query: queryYahooFinance,
    empty: "EMPTY",
    success: "AAPL",
    failure: "FAILED",
  },
])("$provider symbol results", ({ provider, query, empty, success, failure }) => {
  it("propagates a failure when another symbol merely has no match", async () => {
    await expect(query([empty, failure], createProviderFetch())).rejects.toThrow(
      "Market-data request failed (503)",
    )
  })

  it("retains a successful quote alongside empty and failed symbols", async () => {
    const result = await query([empty, success, failure], createProviderFetch())

    expect(result).toHaveLength(1)
    expect(result[0]).toContain(`資料來源: ${provider}`)
  })

  it("returns no data for a successful batch without matches", async () => {
    await expect(query([empty], createProviderFetch())).resolves.toEqual([])
  })

  it("does not fetch or reject for an empty input", async () => {
    const fetchImplementation = createProviderFetch()

    await expect(query([], fetchImplementation)).resolves.toEqual([])
    expect(fetchImplementation).not.toHaveBeenCalled()
  })
})

describe("MAX candidate routing", () => {
  it("falls back to Yahoo for a ticker with an unresolved MAX suffix", async () => {
    const fetchImplementation = createProviderFetch()
    const result = await queryMarketData("GBTC", { fetchImplementation })

    expect(result).toContain("GBTC")
    expect(result).toContain("資料來源: Yahoo Finance")
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
  })

  it("falls back for an unlisted pair even when both currencies are known", async () => {
    const fetchImplementation = createProviderFetch()
    const result = await queryMarketData("LTC-BTC", { fetchImplementation })

    expect(result).toContain("LTC-BTC")
    expect(result).toContain("資料來源: Yahoo Finance")
    expect(
      fetchImplementation.mock.calls.map(([input]) => new URL(String(input)).pathname),
    ).toEqual(["/api/v3/markets", "/v8/finance/chart/LTC-BTC"])
  })

  it("keeps both MAX and Yahoo quotes in a mixed candidate batch", async () => {
    const fetchImplementation = createProviderFetch()
    const result = await queryMarketData("GBTC BTCUSDT", { fetchImplementation })

    expect(result).toContain("GBTC")
    expect(result).toContain("資料來源: Yahoo Finance")
    expect(result).toContain("MAX Exchange BTC/USDT")
    expect(fetchImplementation).toHaveBeenCalledTimes(3)
  })

  it.each(["BTCUSDT", "BTC-USDT", "BTC/USDT", "BTC_USDT"])(
    "matches listed MAX market %s without querying Yahoo",
    async (symbol) => {
      const fetchImplementation = createProviderFetch()
      const result = await queryMarketData(symbol, { fetchImplementation })

      expect(result).toContain("MAX Exchange BTC/USDT")
      expect(fetchImplementation).toHaveBeenCalledTimes(2)
      for (const [input] of fetchImplementation.mock.calls) {
        expect(new URL(String(input)).hostname).toBe("max-api.maicoin.com")
      }
    },
  )

  it("does not fall back after a resolved MAX pair fails", async () => {
    const fetchImplementation = createProviderFetch()

    await expect(queryMarketData("ETHUSDT", { fetchImplementation })).rejects.toThrow(
      "Market-data request failed (503)",
    )
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
    for (const [input] of fetchImplementation.mock.calls) {
      expect(new URL(String(input)).hostname).toBe("max-api.maicoin.com")
    }
  })

  it("returns no data when the Yahoo fallback has no match", async () => {
    await expect(
      queryMarketData("EMPTYUSDT", { fetchImplementation: createProviderFetch() }),
    ).resolves.toBe("")
  })

  it("propagates a Yahoo fallback failure when no data is available", async () => {
    await expect(
      queryMarketData("FAILEDUSDT", { fetchImplementation: createProviderFetch() }),
    ).rejects.toThrow("Market-data request failed (503)")
  })

  it("retains Yahoo fallback data when a resolved MAX pair fails", async () => {
    const result = await queryMarketData("GBTC ETHUSDT", {
      fetchImplementation: createProviderFetch(),
    })

    expect(result).toContain("GBTC")
    expect(result).toContain("資料來源: Yahoo Finance")
    expect(result).not.toContain("MAX Exchange")
  })

  it("retains MAX data when a Yahoo fallback fails", async () => {
    const result = await queryMarketData("FAILEDUSDT BTCUSDT", {
      fetchImplementation: createProviderFetch(),
    })

    expect(result).toContain("MAX Exchange BTC/USDT")
    expect(result).not.toContain("Yahoo Finance")
  })

  it.each(["EMPTY FAILED", "NOTAREALUSDT ETHUSDT"])(
    "propagates mixed symbol failures through the query for %s",
    async (input) => {
      await expect(
        queryMarketData(input, { fetchImplementation: createProviderFetch() }),
      ).rejects.toThrow("Market-data request failed (503)")
    },
  )
})
