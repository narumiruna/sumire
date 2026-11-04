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

// Keep source comfortably below Telegram's native rich-message limit.
export const maxMarketMessageChars = 16_000
export const maxMarketReplies = 10
const maxQuotesPerMessage = 50
const maxSectionsPerMessage = 10

export class MarketDataOutputError extends Error {
  constructor() {
    super("報價內容過長，無法完整傳送；請減少查詢代碼或稍後再試。")
  }
}

export function formatMarketResults(results: readonly (MarketQuote | string)[]): string {
  return groupMarketResults(results)
    .map((item) => (typeof item === "string" ? item : formatQuoteTable(item)))
    .join("\n\n")
}

/** Batch structured quotes before formatting; never cut Markdown or disclosure tags. */
export function formatMarketMessages(results: readonly (MarketQuote | string)[]): string[] {
  const parts: Array<{ text: string; quotes: number }> = []
  for (const group of groupMarketResults(results)) {
    if (typeof group === "string") {
      parts.push({ text: group, quotes: 0 })
      continue
    }
    let batch: MarketQuote[] = []
    for (const quote of group) {
      const candidate = [...batch, quote]
      if (
        batch.length &&
        (candidate.length > maxQuotesPerMessage ||
          Array.from(formatQuoteTable(candidate)).length > maxMarketMessageChars)
      ) {
        parts.push({ text: formatQuoteTable(batch), quotes: batch.length })
        batch = []
      }
      batch.push(quote)
    }
    if (batch.length) parts.push({ text: formatQuoteTable(batch), quotes: batch.length })
  }
  const messages: string[] = []
  let current = ""
  let quoteCount = 0
  let sections = 0
  for (const part of parts) {
    if (Array.from(part.text).length > maxMarketMessageChars) throw new MarketDataOutputError()
    const combined = current ? `${current}\n\n${part.text}` : part.text
    // Also bound table rows and source sections below the native block budget.
    if (
      current &&
      (Array.from(combined).length > maxMarketMessageChars ||
        quoteCount + part.quotes > maxQuotesPerMessage ||
        sections === maxSectionsPerMessage)
    ) {
      messages.push(current)
      current = ""
      quoteCount = 0
      sections = 0
    }
    current = current ? `${current}\n\n${part.text}` : part.text
    quoteCount += part.quotes
    sections++
  }
  if (current) messages.push(current)
  if (messages.length > maxMarketReplies) throw new MarketDataOutputError()
  return messages
}

function groupMarketResults(
  results: readonly (MarketQuote | string)[],
): Array<string | MarketQuote[]> {
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
