import { collectMarketResults } from "./collect-results.js"
import type { MarketQuote, QuotePrices } from "./format.js"
import { finiteNumber, type MarketFetch, record, requestJson, text } from "./http.js"
import { withYahooExtendedHours, yahooQuoteTime } from "./yahoo-extended-hours.js"

export async function queryYahooFinance(
  symbols: readonly string[],
  fetchImplementation?: MarketFetch,
): Promise<MarketQuote[]> {
  const results = await Promise.allSettled(
    symbols.map((symbol) => queryYahooSymbol(symbol, fetchImplementation)),
  )
  return collectMarketResults(results)
}

async function queryYahooSymbol(
  symbol: string,
  fetchImplementation?: MarketFetch,
): Promise<MarketQuote | undefined> {
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
  const regularPrice = finiteNumber(meta.regularMarketPrice)
  const last = regularPrice ?? numberAt(quote?.close, latestIndex)
  if (last === undefined) return undefined

  const resolvedSymbol = text(meta.symbol) ?? symbol
  const name = text(meta.shortName) ?? text(meta.longName) ?? resolvedSymbol
  const currency = text(meta.currency)
  const timezone = text(meta.exchangeTimezoneName)
  const regularTime = finiteNumber(meta.regularMarketTime)
  const candleTime = numberAt(result?.timestamp, latestIndex)
  // A daily candle may still belong to yesterday while the live quote has rolled over.
  const candleDateOrder =
    timezone && regularTime !== undefined && candleTime !== undefined
      ? compareTradingDates(candleTime, regularTime, timezone)
      : undefined
  const aligned = !timezone || candleDateOrder === 0
  // A daily-close fallback must compare against its own preceding candle.
  // Only a newer metadata price can use the latest daily close as its baseline.
  const previousCloseIndex =
    regularPrice === undefined || aligned
      ? latestIndex - 1
      : candleDateOrder === -1
        ? latestIndex
        : -1
  const prices: QuotePrices = {
    changeFrom:
      numberAt(quote?.close, previousCloseIndex) ??
      finiteNumber(meta.previousClose) ??
      finiteNumber(meta.chartPreviousClose),
    currency,
    high: aligned ? numberAt(quote?.high, latestIndex) : undefined,
    last,
    low: aligned ? numberAt(quote?.low, latestIndex) : undefined,
    maximumFractionDigits: pricePrecision(meta.priceHint),
    open: aligned ? numberAt(quote?.open, latestIndex) : undefined,
    volume: aligned ? numberAt(quote?.volume, latestIndex) : undefined,
  }
  const asOf = regularPrice !== undefined ? yahooQuoteTime(meta.regularMarketTime) : undefined
  return withYahooExtendedHours(
    {
      name,
      symbol: resolvedSymbol,
      source: "Yahoo Finance",
      prices,
      ...(asOf
        ? {
            asOf,
            session: "regular" as const,
            notice: "Yahoo 免費來源，可能延遲，非保證即時行情。",
          }
        : {}),
    },
    meta,
    fetchImplementation,
  )
}

function numberAt(value: unknown, index: number): number | undefined {
  return Array.isArray(value) ? finiteNumber(value[index]) : undefined
}

function pricePrecision(value: unknown): number {
  const precision = finiteNumber(value)
  return precision === undefined ? 2 : Math.max(0, Math.min(8, Math.trunc(precision)))
}

function compareTradingDates(left: number, right: number, timezone: string): number | undefined {
  try {
    const format = new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
    const leftDate = format.format(new Date(left * 1_000))
    const rightDate = format.format(new Date(right * 1_000))
    return leftDate === rightDate ? 0 : leftDate < rightDate ? -1 : 1
  } catch {
    return undefined
  }
}
