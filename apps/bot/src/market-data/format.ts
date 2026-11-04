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

export function priceRows(values: {
  changeFrom?: number
  currency?: string
  high?: number
  last?: number
  low?: number
  maximumFractionDigits?: number
  open?: number
  volume?: number
}): MarketDataRow[] {
  const suffix = values.currency ? ` ${values.currency}` : ""
  const price = (value: number) => formatNumber(value, values.maximumFractionDigits)
  const rows: MarketDataRow[] = []
  if (values.last !== undefined) rows.push(["現價", `${price(values.last)}${suffix}`])
  if (values.open !== undefined) rows.push(["開盤", `${price(values.open)}${suffix}`])
  if (values.high !== undefined) rows.push(["最高", `${price(values.high)}${suffix}`])
  if (values.low !== undefined) rows.push(["最低", `${price(values.low)}${suffix}`])
  if (values.last !== undefined && values.changeFrom !== undefined && values.changeFrom !== 0) {
    const change = (values.last / values.changeFrom - 1) * 100
    const icon = change > 0 ? "🔺" : change < 0 ? "🔻" : "⏸️"
    rows.push(["漲跌", `${icon} ${change >= 0 ? "+" : ""}${change.toFixed(2)}%`])
  }
  if (values.volume !== undefined) rows.push(["成交量", formatNumber(values.volume)])
  return rows
}
