import * as cheerio from "cheerio"
import TurndownService from "turndown"

export function normalizeWhitespace(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
}

export function htmlToMarkdown(content: string): string {
  const turndown = new TurndownService({
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    headingStyle: "atx",
  })
  turndown.addRule("plain-links", {
    filter: "a",
    replacement: (innerContent) => innerContent,
  })
  turndown.addRule("drop-images", {
    filter: "img",
    replacement: () => "",
  })
  const $ = cheerio.load(content)
  $("script,style,template").remove()
  return normalizeWhitespace(turndown.turndown($.html()))
}

/** Select semantic document content only for the generic loaders. */
export function genericHtmlToMarkdown(content: string): string {
  const $ = cheerio.load(content)
  $("script,style,template").remove()
  const pending = $.root().children().toArray().reverse()
  const mains: typeof pending = []
  const articles: typeof pending = []
  // Stop at outer regions to avoid repeated ancestor scans on nested input.
  while (pending.length > 0) {
    const element = pending.pop()
    if (!element) break
    if (element.tagName === "nav" || element.tagName === "button") continue
    if (element.tagName === "main") {
      mains.push(element)
      continue
    }
    if (element.tagName === "article") {
      articles.push(element)
      continue
    }
    for (const child of $(element).children().toArray().reverse()) pending.push(child)
  }
  for (const elements of [mains, articles]) {
    const regions = $(elements).clone()
    regions.find("nav,button").remove()
    const markdown = htmlToMarkdown(
      regions
        .toArray()
        .map((element) => $.html(element))
        .join("\n"),
    )
    if (markdown) return markdown
  }
  return htmlToMarkdown(content)
}

export function extractFirstTagSubtree(
  html: string,
  tags: readonly string[],
  ignoredSelectors = "script,style,noscript,svg,nav,header,footer",
): string {
  const $ = cheerio.load(html)
  for (const tag of tags) {
    const element = $(tag).first()
    if (element.length > 0) {
      element.find(ignoredSelectors).remove()
      return $.html(element)
    }
  }
  return html
}

function findArticleBody(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findArticleBody(item)
      if (found) return found
    }
    return undefined
  }
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (typeof record.articleBody === "string" && record.articleBody.trim()) return record.articleBody
  for (const item of Object.values(record)) {
    const found = findArticleBody(item)
    if (found) return found
  }
  return undefined
}

export function extractArticleBodyFromJsonLd(html: string): string | undefined {
  const $ = cheerio.load(html)
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    try {
      const body = findArticleBody(JSON.parse($(script).text()))
      if (body) return normalizeWhitespace(body)
    } catch {
      // Ignore malformed metadata and continue to the next JSON-LD block.
    }
  }
  return undefined
}
