import { priceLines } from "./format.js"
import { finiteNumber, type MarketFetch, record, requestJson, text } from "./http.js"

export async function queryYahooFinance(
  symbols: readonly string[],
  fetchImplementation?: MarketFetch,
): Promise<string[]> {
  const results = await Promise.allSettled(
    symbols.map((symbol) => queryYahooSymbol(symbol, fetchImplementation)),
  )
  const formatted = results.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : [],
  )
  const failure = results.find((result) => result.status === "rejected")
  if (formatted.length === 0 && failure) throw failure.reason
  return formatted
}

async function queryYahooSymbol(
  symbol: string,
  fetchImplementation?: MarketFetch,
): Promise<string | undefined> {
  const url = new URL(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
  )
  url.searchParams.set("interval", "1d")
  url.searchParams.set("range", "5d")
  const root = record(await requestJson(url, fetchImplementation))
  const chart = record(root?.chart)
  const result = Array.isArray(chart?.result) ? record(chart.result[0]) : undefined
  const meta = record(result?.meta)
  if (!meta) return undefined

  const indicators = record(result?.indicators)
  const quote = Array.isArray(indicators?.quote) ? record(indicators.quote[0]) : undefined
  const candleCount = Array.isArray(result?.timestamp)
    ? result.timestamp.length
    : Math.max(
        ...[quote?.close, quote?.high, quote?.low, quote?.open, quote?.volume].map((values) =>
          Array.isArray(values) ? values.length : 0,
        ),
      )
  // Keep every field on the same candle, including missing or short arrays.
  const latestIndex = candleCount - 1
  const last = finiteNumber(meta.regularMarketPrice) ?? numberAt(quote?.close, latestIndex)
  if (last === undefined) return undefined

  const resolvedSymbol = text(meta.symbol) ?? symbol
  const name = text(meta.shortName) ?? text(meta.longName) ?? resolvedSymbol
  const currency = text(meta.currency)
  const lines = priceLines({
    changeFrom:
      numberAt(quote?.close, latestIndex - 1) ??
      finiteNumber(meta.previousClose) ??
      finiteNumber(meta.chartPreviousClose),
    currency,
    high: numberAt(quote?.high, latestIndex),
    last,
    low: numberAt(quote?.low, latestIndex),
    maximumFractionDigits: pricePrecision(meta.priceHint),
    open: numberAt(quote?.open, latestIndex),
    volume: numberAt(quote?.volume, latestIndex),
  })
  return [`📊 ${name} (${resolvedSymbol})`, ...lines, "資料來源: Yahoo Finance"].join("\n")
}

function numberAt(value: unknown, index: number): number | undefined {
  return Array.isArray(value) ? finiteNumber(value[index]) : undefined
}

function pricePrecision(value: unknown): number {
  const precision = finiteNumber(value)
  return precision === undefined ? 2 : Math.max(0, Math.min(8, Math.trunc(precision)))
}
