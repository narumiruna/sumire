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
  if (formatted.length === 0 && results.every((result) => result.status === "rejected")) {
    throw results[0]?.reason
  }
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
  const last = finiteNumber(meta.regularMarketPrice) ?? lastNumber(quote?.close)
  if (last === undefined) return undefined

  const resolvedSymbol = text(meta.symbol) ?? symbol
  const name = text(meta.shortName) ?? text(meta.longName) ?? resolvedSymbol
  const currency = text(meta.currency)
  const lines = priceLines({
    changeFrom:
      previousNumber(quote?.close) ??
      finiteNumber(meta.previousClose) ??
      finiteNumber(meta.chartPreviousClose),
    currency,
    high: lastNumber(quote?.high),
    last,
    low: lastNumber(quote?.low),
    maximumFractionDigits: pricePrecision(meta.priceHint),
    open: lastNumber(quote?.open),
    volume: lastNumber(quote?.volume),
  })
  return [`📊 ${name} (${resolvedSymbol})`, ...lines, "資料來源: Yahoo Finance"].join("\n")
}

function lastNumber(value: unknown): number | undefined {
  return numbers(value).at(-1)
}

function previousNumber(value: unknown): number | undefined {
  return numbers(value).at(-2)
}

function pricePrecision(value: unknown): number {
  const precision = finiteNumber(value)
  return precision === undefined ? 2 : Math.max(0, Math.min(8, Math.trunc(precision)))
}

function numbers(value: unknown): number[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const number = finiteNumber(entry)
        return number === undefined ? [] : [number]
      })
    : []
}
