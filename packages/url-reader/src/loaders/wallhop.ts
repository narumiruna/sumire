import * as cheerio from "cheerio"

import { LoaderContentError, LoaderTimeoutError, TargetHttpError } from "../core/errors.js"
import { runBounded } from "../core/interruption.js"
import type { Loader } from "../core/loader.js"
import { assertPublicUrl, readResponseText, safeFetch } from "../core/network.js"
import type { ResourceProvider } from "../core/resources.js"
import {
  isWallhopUrl,
  parseWallhopTarget,
  requireLoaderApplicability,
  type WallhopTarget,
} from "../sources/applicability.js"
import { DEFAULT_NEWS_ARTICLE_HEADERS } from "./news.js"
import { extractArticleBodyFromJsonLd, htmlToMarkdown } from "./utils.js"

export const DEFAULT_WALLHOP_TIMEOUT_MS = 30_000
export const MAX_WALLHOP_BYTES = 10 * 1024 * 1024
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5

export function extractWallhopArticleText(html: string, url: string, targetUrl: string): string {
  const $ = cheerio.load(html)
  const target = new URL(targetUrl)
  const sources = [
    $("a.source[href]").first().attr("href"),
    $('link[rel="canonical"]').first().attr("href"),
    $('meta[property="og:url"]').first().attr("content"),
  ]
  for (const source of sources) {
    if (!source) continue
    let matches = false
    try {
      const sourceUrl = new URL(source, target)
      const original = isWallhopUrl(sourceUrl.toString())
        ? new URL(parseWallhopTarget(sourceUrl.toString()).targetUrl)
        : sourceUrl
      matches =
        ["http:", "https:"].includes(original.protocol) &&
        !original.username &&
        !original.password &&
        original.hostname === target.hostname &&
        original.port === target.port &&
        original.pathname === target.pathname &&
        (!original.search || original.search === target.search)
    } catch {
      // Invalid source metadata cannot verify the requested article.
    }
    if (!matches) {
      throw new LoaderContentError("WallhopLoader", url, "Wallhop returned a different article")
    }
  }

  const article = $("article").first()
  if (article.length > 0) {
    article.find("script,style,noscript,svg,nav,aside,footer,form,button").remove()
    const body = article
      .find('.body, [itemprop="articleBody"], section[name="articleBody"]')
      .first()
    const prose = body.length
      ? htmlToMarkdown($.html(body))
      : article
          .find("p")
          .not(".meta,.print-source")
          .toArray()
          .map((paragraph) => $(paragraph).text())
          .join("\n")
    if (prose.trim()) return htmlToMarkdown($.html(article))
  }
  const body = extractArticleBodyFromJsonLd(html)
  if (body) return body
  throw new LoaderContentError("WallhopLoader", url, "Could not find Wallhop article body")
}

export class WallhopLoader implements Loader {
  constructor(
    private readonly options: { resources?: ResourceProvider; timeoutMs?: number } = {},
  ) {}

  async load(url: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const target = requireLoaderApplicability("WallhopLoader", url, parseWallhopTarget)
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_WALLHOP_TIMEOUT_MS
    return runBounded(
      (activeSignal) => this.loadArticle(target, activeSignal),
      timeoutMs,
      signal,
      new LoaderTimeoutError("WallhopLoader", url, timeoutMs / 1_000),
    )
  }

  private async validateUrl(url: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.options.resources) await this.options.resources.validateUrl(url, signal)
    else await assertPublicUrl(url, { signal })
    signal.throwIfAborted()
  }

  private async loadArticle(target: WallhopTarget, signal: AbortSignal): Promise<string> {
    let requestUrl = target.rawUrl
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      if (isWallhopUrl(requestUrl)) {
        const redirected = parseWallhopTarget(requestUrl)
        await this.validateUrl(redirected.targetUrl, signal)
        if (redirected.targetUrl !== target.targetUrl) {
          throw new LoaderContentError(
            "WallhopLoader",
            target.url,
            "Wallhop redirect changed the article target",
          )
        }
      }
      await this.validateUrl(requestUrl, signal)
      const init: RequestInit = {
        headers: DEFAULT_NEWS_ARTICLE_HEADERS,
        redirect: "manual",
        signal,
      }
      const response = await (this.options.resources?.fetch(requestUrl, init) ??
        safeFetch(requestUrl, init))
      if (signal.aborted) {
        await response.body?.cancel()
        throw signal.reason
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        await response.body?.cancel()
        if (redirects === MAX_REDIRECTS) {
          throw new LoaderContentError(
            "WallhopLoader",
            target.url,
            "Wallhop exceeded the redirect limit",
          )
        }
        const location = response.headers.get("location")
        if (!location)
          throw new LoaderContentError(
            "WallhopLoader",
            target.url,
            "Wallhop redirect has no Location header",
          )
        requestUrl = new URL(location, requestUrl).toString()
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new TargetHttpError("WallhopLoader", target.url, response.status)
      }
      const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
      if (mediaType !== "text/html" && mediaType !== "application/xhtml+xml") {
        await response.body?.cancel()
        throw new LoaderContentError("WallhopLoader", target.url, "Expected Wallhop HTML content")
      }
      const html = await readResponseText(response, MAX_WALLHOP_BYTES, signal)
      signal.throwIfAborted()
      return extractWallhopArticleText(html, target.url, target.targetUrl)
    }
    throw new LoaderContentError("WallhopLoader", target.url, "Wallhop redirect handling failed")
  }
}
