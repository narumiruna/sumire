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
  session?: "pre" | "regular" | "post" | "closed" | "unknown"
  marketSession?: "pre" | "post"
  regular?: { prices: QuotePrices; asOf?: string }
  exchangeTimezone?: string
  asOf?: string
  notice?: string
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

interface MarketSection {
  summary: string
  details?: string
  heading?: string
  quotes: number
}

export function formatMarketResults(
  results: readonly (MarketQuote | string)[],
  queriedAt?: Date,
): string {
  return renderMessage(
    groupMarketResults(results).map((group) =>
      typeof group === "string" ? { summary: group, quotes: 0 } : formatQuoteSection(group),
    ),
    queriedAt,
  )
}

/** Measure complete messages, including the shared disclosure and query footer. */
export function formatMarketMessages(
  results: readonly (MarketQuote | string)[],
  queriedAt?: Date,
): string[] {
  const parts: MarketSection[] = []
  for (const group of groupMarketResults(results)) {
    if (typeof group === "string") {
      parts.push({ summary: group, quotes: 0 })
      continue
    }
    let batch: MarketQuote[] = []
    for (const quote of group) {
      const candidate = [...batch, quote]
      if (
        batch.length &&
        (candidate.length > maxQuotesPerMessage ||
          messageLength([formatQuoteSection(candidate)], queriedAt) > maxMarketMessageChars)
      ) {
        parts.push(formatQuoteSection(batch))
        batch = []
      }
      batch.push(quote)
    }
    if (batch.length) parts.push(formatQuoteSection(batch))
  }
  const messages: string[] = []
  let current: MarketSection[] = []
  let quoteCount = 0
  for (const part of parts) {
    if (messageLength([part], queriedAt) > maxMarketMessageChars) throw new MarketDataOutputError()
    const candidate = [...current, part]
    // Bound native table rows and sections as well as the complete Unicode source.
    if (
      current.length &&
      (messageLength(candidate, queriedAt) > maxMarketMessageChars ||
        quoteCount + part.quotes > maxQuotesPerMessage ||
        current.length === maxSectionsPerMessage)
    ) {
      messages.push(renderMessage(current, queriedAt))
      current = []
      quoteCount = 0
    }
    current.push(part)
    quoteCount += part.quotes
  }
  if (current.length) messages.push(renderMessage(current, queriedAt))
  if (messages.length > maxMarketReplies) throw new MarketDataOutputError()
  return messages
}

function messageLength(sections: readonly MarketSection[], queriedAt?: Date): number {
  return Array.from(renderMessage(sections, queriedAt)).length
}

function renderMessage(sections: readonly MarketSection[], queriedAt?: Date): string {
  if (!sections.length) return ""
  const detailed = sections.filter((section) => section.details)
  const multipleQuoteGroups = sections.filter((section) => section.quotes > 0).length > 1
  const details = detailed.map((section) =>
    multipleQuoteGroups ? `${section.heading}\n\n${section.details}` : section.details,
  )
  return [
    sections.map((section) => section.summary).join("\n\n"),
    ...(queriedAt ? [`查詢時間：${queryTime(queriedAt)}（台灣）`] : []),
    ...(sections.some((section) => section.quotes > 0) ? ["⚠ 報價可能延遲"] : []),
    ...(details.length
      ? ["<details><summary>詳細報價</summary>", details.join("\n\n"), "</details>"]
      : []),
  ].join("\n\n")
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

function formatQuoteSection(quotes: readonly MarketQuote[]): MarketSection {
  const first = quotes[0]
  if (!first) return { summary: "", quotes: 0 }
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
      `**${escapeMarkdownText(quote.symbol)}**${sessionText(quote.session)}`,
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
  const details = rendered.some((quote, index) => !quotes[index]?.session && quote.hasDetails)
    ? [
        `| 標的 | ${columns.map(([, label]) => label).join(" | ")} |`,
        `| --- | ${columns.map(() => "---:").join(" | ")} |`,
        ...rendered.filter((_, index) => !quotes[index]?.session).map((quote) => quote.detailRow),
      ].join("\n")
    : ""
  const heading = sourceHeading({
    currency: first.prices.currency,
    source: first.source === "Yahoo Finance" ? "Yahoo" : first.source,
  })
  const notices = quotes.flatMap((quote) =>
    quote.notice
      ? [`${escapeMarkdownText(quote.symbol)}：${escapeMarkdownText(quote.notice)}`]
      : [],
  )
  return {
    heading,
    quotes: quotes.length,
    summary: [
      heading,
      "",
      "| 標的 | 現價 | 漲跌 |",
      "| --- | ---: | ---: |",
      ...rendered.map((quote) => quote.row),
    ].join("\n"),
    details:
      [details, ...quotes.filter((quote) => quote.session).map(formatSessionDetails), ...notices]
        .filter(Boolean)
        .join("\n\n") || undefined,
  }
}

/** Session prices and regular-session statistics must never share an unlabeled row. */
function formatSessionDetails(quote: MarketQuote): string {
  const price = (value: number | undefined) =>
    value === undefined
      ? "未提供"
      : new Intl.NumberFormat("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: Math.max(2, quote.prices.maximumFractionDigits ?? 2),
        }).format(value)
  const extended = quote.session === "pre" || quote.session === "post"
  const regular = quote.regular
  const lines = [
    `**${escapeMarkdownText(quote.name === quote.symbol ? quote.symbol : `${quote.symbol} ${quote.name}`)}**`,
    `報價時間：${quoteTime(quote.asOf, quote.exchangeTimezone)}`,
    ...(quote.marketSession
      ? [`${quote.marketSession === "pre" ? "盤前" : "盤後"}報價暫無資料；以下為最近一般交易報價。`]
      : []),
    `漲跌基準：${extended ? "最近一般交易收盤價" : "前一交易日收盤價"} ${price(quote.prices.changeFrom)}`,
  ]
  if (extended) {
    lines.push(quote.session === "pre" ? "今日一般交易尚未開盤。" : "一般交易已結束。")
  }
  if (regular) {
    lines.push(
      `一般交易資料時間：${quoteTime(regular.asOf, quote.exchangeTimezone)}`,
      `${quote.session === "regular" ? "一般交易現價" : "最近一般交易價格"}：${price(regular.prices.last)}（漲跌 ${changeText(regular.prices) ?? "未提供"}）`,
    )
  }
  const values = regular?.prices ?? (extended ? undefined : quote.prices)
  const fields = ["open", "high", "low", "volume"] as const
  if (values && fields.some((field) => values[field] !== undefined)) {
    lines.push(
      "一般交易時段：",
      "",
      "| 開盤 | 最高 | 最低 | 成交量 |",
      "| ---: | ---: | ---: | ---: |",
      `| ${fields
        .map((field) =>
          field === "volume" && values[field] !== undefined
            ? formatNumber(values[field])
            : price(values[field]),
        )
        .join(" | ")} |`,
    )
  } else {
    lines.push("一般交易開高低量：未提供。")
  }
  return lines.join("\n")
}

function quoteTime(value: string | undefined, timezone = "UTC"): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "未提供"
  try {
    return `${escapeMarkdownText(
      new Intl.DateTimeFormat("sv-SE", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).format(new Date(value)),
    )}（${escapeMarkdownText(timezone)}）`
  } catch {
    return `${new Date(value).toISOString()}（UTC）`
  }
}

function sessionText(session: MarketQuote["session"]): string {
  if (session === "pre") return " 盤前"
  if (session === "post") return " 盤後"
  if (session === "regular") return " 交易中"
  if (session === "closed") return " 已收盤"
  if (session === "unknown") return " 時段未確認"
  return ""
}

function queryTime(date: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date)
}

function changeText(values: QuotePrices): string | undefined {
  if (values.last === undefined || values.changeFrom === undefined || values.changeFrom === 0)
    return undefined
  const change = (values.last / values.changeFrom - 1) * 100
  return `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`
}
