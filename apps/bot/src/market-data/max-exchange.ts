import { collectMarketResults } from "./collect-results.js"
import type { MarketQuote, QuotePrices } from "./format.js"
import { finiteNumber, type MarketFetch, record, requestJson, text } from "./http.js"

const maxEndpoint = "https://max-api.maicoin.com"

export async function queryMaxExchange(
  symbols: readonly string[],
  fetchImplementation?: MarketFetch,
  queryUnmatchedSymbol?: (symbol: string) => Promise<MarketQuote | undefined>,
): Promise<MarketQuote[]> {
  if (symbols.length === 0) return []
  let payload: unknown
  try {
    payload = await requestJson(`${maxEndpoint}/api/v3/markets`, fetchImplementation)
  } catch (error) {
    if (!queryUnmatchedSymbol) throw error
    const results = await Promise.allSettled(
      symbols.map(async (symbol) => queryUnmatchedSymbol(symbol)),
    )
    const formatted = results.flatMap((result) =>
      result.status === "fulfilled" && result.value ? [result.value] : [],
    )
    // An unavailable catalogue must not become a misleading no-match result.
    if (formatted.length === 0) throw error
    return formatted
  }
  if (!Array.isArray(payload)) return []

  const markets = payload.flatMap((value) => {
    const market = record(value)
    const id = text(market?.id)?.toLowerCase()
    const base = text(market?.base_unit)?.toLowerCase()
    const quote = text(market?.quote_unit)?.toLowerCase()
    return id && base && quote ? [{ id, base, quote }] : []
  })
  const results = await Promise.allSettled(
    symbols.map(async (symbol) => {
      const market = markets.find((entry) => entry.id === normalizeMaxMarket(symbol))
      if (!market) return queryUnmatchedSymbol?.(symbol)
      const { id, base, quote } = market
      const url = new URL(`${maxEndpoint}/api/v3/ticker`)
      url.searchParams.set("market", id)
      const ticker = record(await requestJson(url, fetchImplementation))
      const last = finiteNumber(ticker?.last)
      if (!ticker || last === undefined) return undefined
      const prices: QuotePrices = {
        changeFrom: finiteNumber(ticker.open),
        currency: quote.toUpperCase(),
        maximumFractionDigits: 8,
        high: finiteNumber(ticker.high),
        last,
        low: finiteNumber(ticker.low),
        open: finiteNumber(ticker.open),
        volume: finiteNumber(ticker.vol),
      }
      const bid = finiteNumber(ticker.buy)
      const ask = finiteNumber(ticker.sell)
      if (bid !== undefined) prices.bid = bid
      if (ask !== undefined) prices.ask = ask
      return {
        name: "MAX Exchange",
        symbol: `${base.toUpperCase()}/${quote.toUpperCase()}`,
        source: "MAX Exchange",
        prices,
      }
    }),
  )
  return collectMarketResults(results)
}

export function normalizeMaxMarket(symbol: string): string {
  return symbol.trim().toLowerCase().replaceAll(/[/_-]/g, "")
}
