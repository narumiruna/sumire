import type { MarketQuote } from "./format.js"
import { finiteNumber, type MarketFetch, record, requestJson } from "./http.js"

interface TradingPeriod {
  start: number
  end: number
}

const extendedHoursNotice =
  "Yahoo 免費來源，可能延遲，非保證即時行情；盤前／盤後漲跌以最近一般交易收盤價為基準。"

/** Only explicit provider session boundaries qualify; do not guess from wall-clock hours. */
export async function withYahooExtendedHours(
  quote: MarketQuote,
  meta: Record<string, unknown>,
  fetchImplementation?: MarketFetch,
): Promise<MarketQuote> {
  const periods = record(meta.currentTradingPeriod)
  const now = Date.now() / 1_000
  const session = (["pre", "post"] as const).find((name) => {
    const period = tradingPeriod(periods?.[name])
    return period !== undefined && now >= period.start && now < period.end
  })
  if (!session) return quote
  const period = tradingPeriod(periods?.[session])
  if (!period) return quote

  const fallback: MarketQuote = {
    ...quote,
    session: "regular",
    notice: "盤前／盤後資料暫不可用；顯示一般交易／收盤價格。Yahoo 免費來源可能延遲。",
  }
  try {
    const url = new URL(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(quote.symbol)}`,
    )
    url.searchParams.set("interval", "1m")
    url.searchParams.set("range", "1d")
    url.searchParams.set("includePrePost", "true")
    const root = record(await requestJson(url, fetchImplementation))
    const chart = record(root?.chart)
    const result = Array.isArray(chart?.result) ? record(chart.result[0]) : undefined
    const timestamps = result?.timestamp
    if (!Array.isArray(timestamps) || !timestamps.length) return fallback
    // Never backfill a null latest point with an older minute or another session.
    const index = timestamps.length - 1
    const timestamp = finiteNumber(timestamps[index])
    const indicators = record(result?.indicators)
    const values = Array.isArray(indicators?.quote) ? record(indicators.quote[0]) : undefined
    const last = Array.isArray(values?.close) ? finiteNumber(values.close[index]) : undefined
    const receivedAt = Date.now() / 1_000
    if (
      timestamp === undefined ||
      timestamp < period.start ||
      timestamp >= period.end ||
      timestamp > receivedAt ||
      receivedAt >= period.end ||
      last === undefined ||
      last <= 0
    ) {
      return fallback
    }

    const regularTime = finiteNumber(meta.regularMarketTime)
    const regularPeriod = tradingPeriod(periods?.regular)
    const hasBaseline =
      regularTime !== undefined &&
      regularTime > 0 &&
      regularTime <= timestamp &&
      (session === "pre"
        ? regularTime < period.start
        : regularPeriod !== undefined && regularTime >= regularPeriod.start)
    return {
      ...quote,
      session,
      asOf: new Date(timestamp * 1_000).toISOString(),
      notice: extendedHoursNotice,
      // A minute candle's OHLC/volume must not masquerade as session-wide statistics.
      prices: {
        last,
        changeFrom: hasBaseline ? finiteNumber(meta.regularMarketPrice) : undefined,
        currency: quote.prices.currency,
        maximumFractionDigits: quote.prices.maximumFractionDigits,
      },
    }
  } catch {
    // Preserve the existing regular quote when the optional free endpoint fails.
    return fallback
  }
}

function tradingPeriod(value: unknown): TradingPeriod | undefined {
  const period = record(value)
  const start = finiteNumber(period?.start)
  const end = finiteNumber(period?.end)
  if (start === undefined || end === undefined || start <= 0 || end <= start) return undefined
  return { start, end }
}

export function yahooQuoteTime(value: unknown): string | undefined {
  const timestamp = finiteNumber(value)
  if (timestamp === undefined || timestamp <= 0) return undefined
  const date = new Date(timestamp * 1_000)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}
