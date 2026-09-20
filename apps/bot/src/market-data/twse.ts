import { priceLines } from "./format.js"
import { finiteNumber, type MarketFetch, record, requestJson, text } from "./http.js"

const twseEndpoint = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp"

export async function queryTwse(
  symbols: readonly string[],
  fetchImplementation?: MarketFetch,
): Promise<string[]> {
  if (symbols.length === 0) return []
  const url = new URL(twseEndpoint)
  url.searchParams.set(
    "ex_ch",
    symbols.flatMap((symbol) => [`tse_${symbol}.tw`, `otc_${symbol}.tw`]).join("|"),
  )
  url.searchParams.set("json", "1")
  url.searchParams.set("delay", "0")
  url.searchParams.set("_", String(Date.now()))

  const root = record(await requestJson(url, fetchImplementation))
  if (!Array.isArray(root?.msgArray)) return []
  return root.msgArray.flatMap((value) => {
    const formatted = formatTwseStock(value)
    return formatted ? [formatted] : []
  })
}

function formatTwseStock(value: unknown): string | undefined {
  const stock = record(value)
  const symbol = text(stock?.c)
  const name = text(stock?.n)
  if (!stock || !symbol || !name) return undefined

  const midpoint = orderBookMidpoint(text(stock.a), text(stock.b))
  const last = positiveNumber(stock.z) ?? positiveNumber(stock.pz) ?? midpoint
  const lines = priceLines({
    changeFrom: positiveNumber(stock.y),
    currency: "TWD",
    high: positiveNumber(stock.h),
    last,
    low: positiveNumber(stock.l),
    maximumFractionDigits: 2,
    open: positiveNumber(stock.o),
    volume: positiveNumber(stock.v),
  })
  if (lines.length === 0) return undefined
  return [`📊 ${name} (${symbol})`, ...lines, "資料來源: TWSE"].join("\n")
}

function positiveNumber(value: unknown): number | undefined {
  const number = finiteNumber(value)
  return number !== undefined && number > 0 ? number : undefined
}

function orderBookMidpoint(askText?: string, bidText?: string): number | undefined {
  const asks = prices(askText)
  const bids = prices(bidText)
  const ask = asks.length > 0 ? Math.min(...asks) : undefined
  const bid = bids.length > 0 ? Math.max(...bids) : undefined
  if (ask !== undefined && bid !== undefined) return (ask + bid) / 2
  return ask ?? bid
}

function prices(value?: string): number[] {
  return (value ?? "")
    .split("_")
    .map((part) => finiteNumber(part))
    .filter((number): number is number => number !== undefined && number > 0)
}
