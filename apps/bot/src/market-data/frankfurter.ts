import { parseCurrencyPair } from "./exchange-rates.js"
import { formatNumber } from "./format.js"
import { finiteNumber, type MarketFetch, record, requestJson, text } from "./http.js"

interface FrankfurterRate {
  base: string
  date: string
  quote: string
  rate: number
}

export async function queryFrankfurterRates(
  pairs: readonly string[],
  fetchImplementation?: MarketFetch,
): Promise<string[]> {
  const requests = pairs.flatMap((pair) => {
    const currencies = parseCurrencyPair(pair)
    return currencies ? [fetchFrankfurterRate(...currencies, fetchImplementation)] : []
  })
  const settled = await Promise.allSettled(requests)
  const results = settled.flatMap((result) =>
    result.status === "fulfilled" ? [formatFrankfurterRate(result.value)] : [],
  )
  const failure = settled.find((result) => result.status === "rejected")
  if (results.length === 0 && failure) throw failure.reason
  return results
}

async function fetchFrankfurterRate(
  source: string,
  target: string,
  fetchImplementation?: MarketFetch,
): Promise<FrankfurterRate> {
  const url = new URL(
    `https://api.frankfurter.dev/v2/rate/${encodeURIComponent(source)}/${encodeURIComponent(target)}`,
  )
  const payload = record(await requestJson(url, fetchImplementation))
  const base = text(payload?.base)?.toUpperCase()
  const quote = text(payload?.quote)?.toUpperCase()
  const date = text(payload?.date)
  const rate = finiteNumber(payload?.rate)
  if (
    base !== source ||
    quote !== target ||
    !date ||
    !isIsoDate(date) ||
    rate === undefined ||
    rate <= 0
  ) {
    throw new Error("Unexpected Frankfurter exchange-rate response")
  }
  return { base, date, quote, rate }
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function formatFrankfurterRate(rate: FrankfurterRate): string {
  return [
    `💱 Frankfurter ${rate.base}/${rate.quote}`,
    `參考中價: ${formatNumber(rate.rate)} ${rate.quote}`,
    `資料日期: ${formatDate(rate.date)}`,
    "資料來源: Frankfurter v2",
  ].join("\n")
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-TW", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00.000Z`))
}
