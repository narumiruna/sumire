import { formatNumber, priceLines } from "./format.js"
import { finiteNumber, type MarketFetch, record, requestJson, text } from "./http.js"

const maxEndpoint = "https://max-api.maicoin.com"

export async function queryMaxExchange(
  symbols: readonly string[],
  fetchImplementation?: MarketFetch,
  queryUnmatchedSymbol?: (symbol: string) => Promise<string | undefined>,
): Promise<string[]> {
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
      const lines = priceLines({
        changeFrom: finiteNumber(ticker.open),
        currency: quote.toUpperCase(),
        high: finiteNumber(ticker.high),
        last,
        low: finiteNumber(ticker.low),
        open: finiteNumber(ticker.open),
        volume: finiteNumber(ticker.vol),
      })
      const bid = finiteNumber(ticker.buy)
      const ask = finiteNumber(ticker.sell)
      if (bid !== undefined) lines.push(`買價: ${formatNumber(bid)} ${quote.toUpperCase()}`)
      if (ask !== undefined) lines.push(`賣價: ${formatNumber(ask)} ${quote.toUpperCase()}`)
      return [
        `📊 MAX Exchange ${base.toUpperCase()}/${quote.toUpperCase()}`,
        ...lines,
        "資料來源: MAX Exchange",
      ].join("\n")
    }),
  )
  const formatted = results.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : [],
  )
  const failure = results.find((result) => result.status === "rejected")
  if (formatted.length === 0 && failure) throw failure.reason
  return formatted
}

export function normalizeMaxMarket(symbol: string): string {
  return symbol.trim().toLowerCase().replaceAll(/[/_-]/g, "")
}
