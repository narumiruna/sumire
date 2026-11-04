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
  const rendered = quotes.map((quote) => {
    const values = quote.prices
    const price = (value: number) =>
      new Intl.NumberFormat("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: Math.max(2, values.maximumFractionDigits ?? 2),
      }).format(value)
    const change = changeText(values)
    const cells = [
      `**${escapeMarkdownText(quote.symbol)}**`,
      values.last === undefined ? "—" : `**${price(values.last)}**`,
      change === undefined ? "—" : `**${change}**`,
    ]
    const label = quote.name === quote.symbol ? quote.symbol : `${quote.symbol} ${quote.name}`
    const range = (
      [
        ["開盤", values.open],
        ["最高", values.high],
        ["最低", values.low],
      ] as const
    ).flatMap(([label, value]) => (value === undefined ? [] : [`${label} ${price(value)}`]))
    const trades: string[] = []
    if (values.volume !== undefined) trades.push(`成交量 ${formatNumber(values.volume)}`)
    if (values.bid !== undefined) trades.push(`買價 ${price(values.bid)}`)
    if (values.ask !== undefined) trades.push(`賣價 ${price(values.ask)}`)
    const details = [
      `**${escapeMarkdownText(label)}**`,
      ...(range.length ? [range.join(" · ")] : []),
      ...(trades.length ? [trades.join(" · ")] : []),
    ].join("\n")
    return { row: `| ${cells.join(" | ")} |`, details }
  })
  const unit = first.prices.currency ? escapeMarkdownText(first.prices.currency) : "未提供"
  return [
    "| 標的 | 現價 | 漲跌 |",
    "| --- | ---: | ---: |",
    ...rendered.map((quote) => quote.row),
    "",
    rendered.map((quote) => quote.details).join("\n\n"),
    "",
    `價格單位：${unit}｜資料來源：${escapeMarkdownText(first.source)}`,
  ].join("\n")
}

function changeText(values: QuotePrices): string | undefined {
  if (values.last === undefined || values.changeFrom === undefined || values.changeFrom === 0)
    return undefined
  const change = (values.last / values.changeFrom - 1) * 100
  return `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`
}
