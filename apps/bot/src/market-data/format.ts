export function formatNumber(value: number, maximumFractionDigits = 8): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value)
}

export type MarketDataRow = readonly [label: string, value: string]

export function formatMarketTable(title: string, rows: readonly MarketDataRow[]): string {
  return [
    escapeMarkdownText(title),
    "",
    "| 項目 | 數值 |",
    "| --- | --- |",
    ...rows.map(
      ([label, value]) => `| ${escapeMarkdownText(label)} | ${escapeMarkdownText(value)} |`,
    ),
  ].join("\n")
}

function escapeMarkdownText(value: string): string {
  return value.replace(/[\r\n\t]+/gu, " ").replace(/[\\|`*_[\]<>~]/gu, "\\$&")
}

export interface QuotePrices {
  ask?: number
  bid?: number
  changeFrom?: number
  currency?: string
  high?: number
  last?: number
  low?: number
  maximumFractionDigits?: number
  open?: number
  volume?: number
}

export interface MarketQuote {
  name: string
  symbol: string
  source: string
  prices: QuotePrices
}

export function formatMarketResults(results: readonly (MarketQuote | string)[]): string {
  const groups = new Map<string, MarketQuote[]>()
  const output: Array<string | MarketQuote[]> = []
  for (const result of results) {
    if (typeof result === "string") {
      output.push(result)
      continue
    }
    // Never put prices with different units or sources under a shared footer.
    const key = JSON.stringify([result.prices.currency, result.source])
    let group = groups.get(key)
    if (!group) {
      group = []
      groups.set(key, group)
      output.push(group)
    }
    group.push(result)
  }
  return output
    .map((item) => (typeof item === "string" ? item : formatQuoteTable(item)))
    .join("\n\n")
}

function formatQuoteTable(quotes: readonly MarketQuote[]): string {
  const first = quotes[0]
  if (!first) return ""
  const bid = quotes.some((quote) => quote.prices.bid !== undefined)
  const ask = quotes.some((quote) => quote.prices.ask !== undefined)
  const headers = ["標的", "現價", "漲跌幅", "開盤", "最高", "最低", "成交量"]
  if (bid) headers.push("買價")
  if (ask) headers.push("賣價")
  const rows = quotes.map((quote) => {
    const values = quote.prices
    const price = (value: number | undefined) =>
      value === undefined
        ? "—"
        : new Intl.NumberFormat("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: Math.max(2, values.maximumFractionDigits ?? 2),
          }).format(value)
    const label = quote.name === quote.symbol ? quote.symbol : `${quote.symbol} ${quote.name}`
    const change = changeText(values)
    const cells = [
      `**${escapeMarkdownText(label)}**`,
      values.last === undefined ? "—" : `**${price(values.last)}**`,
      change === undefined ? "—" : `**${change}**`,
      price(values.open),
      price(values.high),
      price(values.low),
      values.volume === undefined ? "—" : formatNumber(values.volume),
    ]
    if (bid) cells.push(price(values.bid))
    if (ask) cells.push(price(values.ask))
    return `| ${cells.join(" | ")} |`
  })
  const unit = first.prices.currency ? escapeMarkdownText(first.prices.currency) : "未提供"
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map((_, index) => (index === 0 ? "---" : "---:")).join(" | ")} |`,
    ...rows,
    "",
    `價格單位：${unit}｜資料來源：${escapeMarkdownText(first.source)}`,
  ].join("\n")
}

function changeText(values: QuotePrices): string | undefined {
  if (values.last === undefined || values.changeFrom === undefined || values.changeFrom === 0)
    return undefined
  const change = (values.last / values.changeFrom - 1) * 100
  const icon = change > 0 ? "🔺" : change < 0 ? "🔻" : "⏸️"
  return `${icon} ${change >= 0 ? "+" : ""}${change.toFixed(2)}%`
}
