import { fetchRates, type Rate } from "taiwan-exchange-rates"
import { formatNumber } from "./format.js"

export type ExchangeRateFetcher = () => Promise<readonly Rate[]>

const defaultRateFetcher = createCachedExchangeRateFetcher(() => fetchRates("BANK_OF_TAIWAN"))

export function createCachedExchangeRateFetcher(
  fetcher: ExchangeRateFetcher,
  options: { now?: () => number; ttlMs?: number } = {},
): ExchangeRateFetcher {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? 15 * 60 * 1_000
  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new Error("Exchange-rate cache TTL must be a non-negative finite number")
  }
  let cached: { expiresAt: number; rates: readonly Rate[] } | undefined
  let pending: Promise<readonly Rate[]> | undefined

  return async () => {
    const currentTime = now()
    if (cached && currentTime < cached.expiresAt) return cached.rates
    if (pending) return pending
    pending = fetcher()
      .then((rates) => {
        cached = { expiresAt: now() + ttlMs, rates }
        return rates
      })
      .finally(() => {
        pending = undefined
      })
    return pending
  }
}

export async function queryExchangeRates(
  pairs: readonly string[],
  fetcher: ExchangeRateFetcher = defaultRateFetcher,
): Promise<string[]> {
  if (pairs.length === 0) return []
  const rates = await fetcher()
  const byPair = new Map(
    rates.map((rate) => [`${rate.source.toUpperCase()}/${rate.target.toUpperCase()}`, rate]),
  )
  return pairs.flatMap((pair) => {
    const currencies = parseCurrencyPair(pair)
    if (!currencies) return []
    const [source, target] = currencies
    const resolved = resolveRate(source, target, byPair)
    return resolved ? [formatExchangeRate(resolved.rate, resolved.derived)] : []
  })
}

export function parseCurrencyPair(value: string): readonly [string, string] | undefined {
  const match = /^([A-Z]{3})(?:[/_-]?([A-Z]{3}))?$/u.exec(value.toUpperCase())
  const source = match?.[1]
  const target = match?.[2] ?? "TWD"
  return source && source !== target ? [source, target] : undefined
}

function resolveRate(
  source: string,
  target: string,
  byPair: ReadonlyMap<string, Rate>,
): { derived: boolean; rate: Rate } | undefined {
  const direct = byPair.get(`${source}/${target}`)
  if (direct) return { derived: false, rate: direct }

  const reverse = byPair.get(`${target}/${source}`)
  return reverse ? { derived: true, rate: invertRate(reverse) } : undefined
}

function invertRate(rate: Rate): Rate {
  return {
    cashBuy: divide(1, rate.cashSell),
    cashSell: divide(1, rate.cashBuy),
    exchange: rate.exchange,
    fetchedAt: rate.fetchedAt,
    source: rate.target,
    spotBuy: divide(1, rate.spotSell),
    spotSell: divide(1, rate.spotBuy),
    target: rate.source,
  }
}

function divide(
  numerator: number | undefined,
  denominator: number | undefined,
): number | undefined {
  if (numerator === undefined || denominator === undefined || denominator === 0) return undefined
  return numerator / denominator
}

function formatExchangeRate(rate: Rate, derived: boolean): string {
  const lines = [`💱 台灣銀行 ${rate.source}/${rate.target}`]
  appendRate(lines, "即期買入", rate.spotBuy, rate.target)
  appendRate(lines, "即期賣出", rate.spotSell, rate.target)
  if (rate.spotBuy !== undefined && rate.spotSell !== undefined) {
    appendRate(lines, "即期中價", (rate.spotBuy + rate.spotSell) / 2, rate.target)
  }
  appendRate(lines, "現鈔買入", rate.cashBuy, rate.target)
  appendRate(lines, "現鈔賣出", rate.cashSell, rate.target)
  if (derived) lines.push("換算方式: 依台灣銀行牌告匯率換算")
  lines.push(`資料時間: ${formatTimestamp(rate.fetchedAt)}`, "資料來源: 台灣銀行")
  return lines.join("\n")
}

function appendRate(
  lines: string[],
  label: string,
  value: number | undefined,
  target: string,
): void {
  if (value !== undefined) lines.push(`${label}: ${formatNumber(value)} ${target}`)
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat("zh-TW", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Asia/Taipei",
  }).format(date)
}
