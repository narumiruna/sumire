import { formatNumber, priceLines } from "./format.js"
import { finiteNumber, type MarketFetch, record, requestJson, text } from "./http.js"

const maxEndpoint = "https://max-api.maicoin.com"

export async function queryMaxExchange(
  symbols: readonly string[],
  fetchImplementation?: MarketFetch,
  queryUnmatchedSymbol?: (symbol: string) => Promise<string | undefined>,
): Promise<string[]> {
  if (symbols.length === 0) return []
  const payload = await requestJson(`${maxEndpoint}/api/v3/currencies`, fetchImplementation)
  if (!Array.isArray(payload)) return []

  const currencies = payload.flatMap((value) => {
    const currency = record(value)
    const code = text(currency?.currency)?.toLowerCase()
    const type = text(currency?.type)
    return code && type ? [{ code, type }] : []
  })
  const results = await Promise.allSettled(
    symbols.map(async (symbol) => {
      const pair = splitMarket(symbol, currencies)
      if (!pair) return queryUnmatchedSymbol?.(symbol)
      const [base, quote] = pair
      const url = new URL(`${maxEndpoint}/api/v3/ticker`)
      url.searchParams.set("market", `${base}${quote}`)
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

function splitMarket(
  symbol: string,
  currencies: readonly { code: string; type: string }[],
): [string, string] | undefined {
  const market = normalizeMaxMarket(symbol)
  const codes = new Set(currencies.map((currency) => currency.code))
  const bases = currencies
    .filter((currency) => currency.type === "crypto")
    .map((currency) => currency.code)
    .sort((left, right) => right.length - left.length)
  for (const base of bases) {
    if (!market.startsWith(base)) continue
    const quote = market.slice(base.length)
    if (codes.has(quote)) return [base, quote]
  }
  return undefined
}

export function normalizeMaxMarket(symbol: string): string {
  return symbol.trim().toLowerCase().replaceAll(/[/_-]/g, "")
}
