export function formatNumber(value: number, maximumFractionDigits = 8): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value)
}

export function priceLines(values: {
  changeFrom?: number
  currency?: string
  high?: number
  last?: number
  low?: number
  maximumFractionDigits?: number
  open?: number
  volume?: number
}): string[] {
  const suffix = values.currency ? ` ${values.currency}` : ""
  const price = (value: number) => formatNumber(value, values.maximumFractionDigits)
  const lines: string[] = []
  if (values.last !== undefined) lines.push(`現價: ${price(values.last)}${suffix}`)
  if (values.open !== undefined) lines.push(`開盤: ${price(values.open)}${suffix}`)
  if (values.high !== undefined) lines.push(`最高: ${price(values.high)}${suffix}`)
  if (values.low !== undefined) lines.push(`最低: ${price(values.low)}${suffix}`)
  if (values.last !== undefined && values.changeFrom !== undefined && values.changeFrom !== 0) {
    const change = (values.last / values.changeFrom - 1) * 100
    const icon = change > 0 ? "🔺" : change < 0 ? "🔻" : "⏸️"
    lines.push(`漲跌: ${icon} ${change >= 0 ? "+" : ""}${change.toFixed(2)}%`)
  }
  if (values.volume !== undefined) lines.push(`成交量: ${formatNumber(values.volume)}`)
  return lines
}
