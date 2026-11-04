export function formatNumber(value: number, maximumFractionDigits = 8): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits,
    minimumFractionDigits: 0,
  }).format(value)
}

export type MarketDataRow = readonly [label: string, value: string]

interface MarketSource {
  currency?: string
  source: string
}

function sourceHeading(metadata: MarketSource): string {
  const unit = metadata.currency ? escapeMarkdownText(metadata.currency) : "未提供"
  return `**${escapeMarkdownText(metadata.source)}｜${unit}**`
}

export function formatMarketTable(
  title: string,
  rows: readonly MarketDataRow[],
  metadata?: MarketSource,
): string {
  return [
    ...(metadata ? [sourceHeading(metadata), ""] : []),
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
    // Never put prices with different units or sources under a shared source heading.
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
  const columns: Array<readonly ["open" | "high" | "low" | "volume" | "bid" | "ask", string]> = [
    ["open", "開盤"],
    ["high", "最高"],
    ["low", "最低"],
    ["volume", "成交量"],
  ]
  if (quotes.some((quote) => quote.prices.bid !== undefined)) columns.push(["bid", "買價"])
  if (quotes.some((quote) => quote.prices.ask !== undefined)) columns.push(["ask", "賣價"])
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
    const hasName = quote.name !== quote.symbol && quote.name !== quote.source
    const label = hasName ? `${quote.symbol} ${quote.name}` : quote.symbol
    const detailCells = [
      `**${escapeMarkdownText(label)}**`,
      ...columns.map(([field]) => {
        const value = values[field]
        return value === undefined ? "—" : field === "volume" ? formatNumber(value) : price(value)
      }),
    ]
    return {
      row: `| ${cells.join(" | ")} |`,
      detailRow: `| ${detailCells.join(" | ")} |`,
      hasDetails: hasName || columns.some(([field]) => values[field] !== undefined),
    }
  })
  const details = rendered.some((quote) => quote.hasDetails)
    ? [
        `| 標的 | ${columns.map(([, label]) => label).join(" | ")} |`,
        `| --- | ${columns.map(() => "---:").join(" | ")} |`,
        ...rendered.map((quote) => quote.detailRow),
      ].join("\n")
    : ""
  return [
    sourceHeading({ currency: first.prices.currency, source: first.source }),
    "",
    "| 標的 | 現價 | 漲跌 |",
    "| --- | ---: | ---: |",
    ...rendered.map((quote) => quote.row),
    ...(details
      ? ["", "<details><summary>查看完整名稱與詳細報價</summary>", "", details, "", "</details>"]
      : []),
  ].join("\n")
}

function changeText(values: QuotePrices): string | undefined {
  if (values.last === undefined || values.changeFrom === undefined || values.changeFrom === 0)
    return undefined
  const change = (values.last / values.changeFrom - 1) * 100
  return `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`
}
