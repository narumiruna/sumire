import { type ExchangeRateFetcher, queryExchangeRates } from "./exchange-rates.js"
import { queryFrankfurterRates } from "./frankfurter.js"
import type { MarketFetch } from "./http.js"
import { normalizeMaxMarket, queryMaxExchange } from "./max-exchange.js"
import { queryTwse } from "./twse.js"
import { queryYahooFinance } from "./yahoo-finance.js"

export const maxMarketTermLength = 64
export const maxMarketTerms = 10

const taiwanBankCurrencies = new Set([
  "AUD",
  "CAD",
  "CHF",
  "CNY",
  "EUR",
  "GBP",
  "HKD",
  "IDR",
  "JPY",
  "KRW",
  "MYR",
  "NZD",
  "PHP",
  "SEK",
  "SGD",
  "THB",
  "TWD",
  "USD",
  "VND",
  "ZAR",
])
const maxQuoteCurrencies = ["usdt", "twd", "btc"]

export type MarketProvider =
  | "Bank of Taiwan"
  | "Frankfurter"
  | "MAX Exchange"
  | "TWSE"
  | "Yahoo Finance"

export interface MarketDataDependencies {
  fetchImplementation?: MarketFetch
  onError?: (provider: MarketProvider, error: unknown) => void
  rateFetcher?: ExchangeRateFetcher
}

export class MarketDataInputError extends Error {}

export async function queryMarketData(
  input: string,
  dependencies: MarketDataDependencies = {},
): Promise<string> {
  const terms = parseMarketTerms(input)
  const groups = {
    currency: [] as string[],
    max: [] as string[],
    twse: [] as string[],
    yahoo: [] as string[],
  }
  for (const term of terms) {
    const classified = classifyMarketTerm(term)
    groups[classified.provider].push(classified.symbol)
  }

  const jobs: Array<{ name: MarketProvider; query: () => Promise<string[]> }> = []
  if (groups.yahoo.length > 0) {
    jobs.push({
      name: "Yahoo Finance",
      query: () => queryYahooFinance(groups.yahoo, dependencies.fetchImplementation),
    })
  }
  if (groups.twse.length > 0) {
    jobs.push({
      name: "TWSE",
      query: () => queryTwse(groups.twse, dependencies.fetchImplementation),
    })
  }
  if (groups.max.length > 0) {
    jobs.push({
      name: "MAX Exchange",
      query: () =>
        queryMaxExchange(groups.max, dependencies.fetchImplementation, async (symbol) => {
          const results = await queryYahooFinance([symbol], dependencies.fetchImplementation)
          return results[0]
        }),
    })
  }
  if (groups.currency.length > 0) {
    jobs.push({
      name: "Frankfurter",
      query: () => queryFrankfurterRates(groups.currency, dependencies.fetchImplementation),
    })
    const bankPairs = groups.currency.filter(includesTwd)
    if (bankPairs.length > 0) {
      jobs.push({
        name: "Bank of Taiwan",
        query: () => queryExchangeRates(bankPairs, dependencies.rateFetcher),
      })
    }
  }

  const settled = await Promise.allSettled(jobs.map((job) => job.query()))
  const results: string[] = []
  for (const [index, result] of settled.entries()) {
    if (result.status === "fulfilled") {
      results.push(...result.value)
    } else {
      const job = jobs[index]
      if (job) dependencies.onError?.(job.name, result.reason)
    }
  }
  const failure = settled.find((result) => result.status === "rejected")
  if (results.length === 0 && failure) throw failure.reason
  return results.join("\n\n")
}

export function parseMarketTerms(input: string): string[] {
  const terms = [
    ...new Set(
      input
        .split(/[\s,]+/u)
        .map((term) => term.trim().toUpperCase())
        .filter(Boolean),
    ),
  ]
  if (terms.length > maxMarketTerms) {
    throw new MarketDataInputError(`一次最多查詢 ${maxMarketTerms} 個代碼。`)
  }
  if (terms.some((term) => Array.from(term).length > maxMarketTermLength)) {
    throw new MarketDataInputError(`每個代碼最多 ${maxMarketTermLength} 個字元。`)
  }
  return terms
}

export function classifyMarketTerm(term: string): {
  provider: "currency" | "max" | "twse" | "yahoo"
  symbol: string
} {
  const currency = currencyFromTerm(term)
  if (currency) return { provider: "currency", symbol: currency }
  if (/^(?:\d{4,6}|\d{4,5}[A-Z])$/u.test(term)) return { provider: "twse", symbol: term }
  // The suffix only identifies a candidate; unresolved MAX pairs fall back to Yahoo.
  const maxMarket = normalizeMaxMarket(term)
  if (
    maxQuoteCurrencies.some((quote) => maxMarket.length > quote.length && maxMarket.endsWith(quote))
  ) {
    return { provider: "max", symbol: term }
  }
  return { provider: "yahoo", symbol: term }
}

function includesTwd(pair: string): boolean {
  return pair.startsWith("TWD/") || pair.endsWith("/TWD")
}

function currencyFromTerm(term: string): string | undefined {
  if (/^[A-Z]{3}$/u.test(term) && term !== "TWD" && taiwanBankCurrencies.has(term)) {
    return `${term}/TWD`
  }
  const match = /^([A-Z]{3})[/_-]?([A-Z]{3})$/u.exec(term)
  const source = match?.[1]
  const target = match?.[2]
  if (
    !source ||
    !target ||
    source === target ||
    !taiwanBankCurrencies.has(source) ||
    !taiwanBankCurrencies.has(target)
  ) {
    return undefined
  }
  return `${source}/${target}`
}
