import * as cheerio from "cheerio"

import { LoaderContentError } from "../core/errors.js"
import type { Loader } from "../core/loader.js"
import type { ResourceProvider } from "../core/resources.js"
import {
  isThreadsPostUrl,
  isThreadsShareUrl,
  parseThreadsTarget,
  type ThreadsTarget,
} from "../sources/applicability.js"
import { ensureUsableContent } from "./content-guard.js"
import { DEFAULT_HTTP_HEADERS, fetchHttpHtml } from "./generic.js"

export const DEFAULT_THREADS_TIMEOUT_MS = 20_000
export const MAX_THREADS_BYTES = 2 * 1024 * 1024
const THREADS_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

function metaContent($: cheerio.CheerioAPI, selectors: readonly string[]): string {
  for (const selector of selectors) {
    const value = $(selector).first().attr("content")?.trim()
    if (value) return value
  }
  return ""
}

function normalizePostBody(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
}

function renderAuthor(title: string, username: string): string {
  const normalizedTitle = title.replace(/\s+/gu, " ").trim()
  const match = /^(.*?)\s+\(@([A-Za-z0-9._]+)\)\s+on Threads$/iu.exec(normalizedTitle)
  const name = match?.[1]?.trim()
  const handle = match?.[2] ?? username
  return name ? `${name} (@${handle})` : `@${handle}`
}

export function extractThreadsSharePost(html: string, url: string, finalUrl = url): string {
  const $ = cheerio.load(html)
  const ogUrl = metaContent($, ['meta[property="og:url"]'])
  const canonicalUrl = $('link[rel="canonical"]').first().attr("href")?.trim() ?? ""
  let ogTarget: ThreadsTarget
  let canonicalTarget: ThreadsTarget
  try {
    ogTarget = parseThreadsTarget(ogUrl)
    canonicalTarget = parseThreadsTarget(canonicalUrl)
    if (
      new URL(ogUrl).username ||
      new URL(ogUrl).password ||
      new URL(canonicalUrl).username ||
      new URL(canonicalUrl).password
    ) {
      throw new Error("Post metadata contains credentials")
    }
  } catch {
    throw new LoaderContentError("ThreadsLoader", url, "Could not verify the shared Threads post")
  }
  const finalTarget = isThreadsPostUrl(finalUrl) ? parseThreadsTarget(finalUrl) : undefined
  if (
    ogTarget.shortcode !== canonicalTarget.shortcode ||
    ogTarget.username.toLowerCase() !== canonicalTarget.username.toLowerCase() ||
    (finalTarget &&
      (ogTarget.shortcode !== finalTarget.shortcode ||
        ogTarget.username.toLowerCase() !== finalTarget.username.toLowerCase()))
  ) {
    throw new LoaderContentError("ThreadsLoader", url, "Shared Threads post metadata disagrees")
  }
  return extractThreadsPost(html, ogTarget)
}

export function extractThreadsPost(html: string, target: ThreadsTarget): string {
  const $ = cheerio.load(html)
  const canonicalUrl =
    metaContent($, ['meta[property="og:url"]']) ||
    $('link[rel="canonical"]').first().attr("href")?.trim() ||
    ""
  let canonicalTarget: ThreadsTarget
  try {
    canonicalTarget = parseThreadsTarget(canonicalUrl)
  } catch {
    throw new LoaderContentError(
      "ThreadsLoader",
      target.url,
      "Could not verify the requested Threads post",
    )
  }
  if (canonicalTarget.shortcode !== target.shortcode) {
    throw new LoaderContentError(
      "ThreadsLoader",
      target.url,
      `Threads returned a different post (${canonicalTarget.shortcode})`,
    )
  }

  const body = normalizePostBody(
    metaContent($, [
      'meta[property="og:description"]',
      'meta[name="twitter:description"]',
      'meta[name="description"]',
    ]),
  )
  ensureUsableContent(body, { loaderName: "ThreadsLoader", url: target.url })
  const title = metaContent($, ['meta[property="og:title"]', 'meta[name="twitter:title"]'])
  const author = renderAuthor(title, canonicalTarget.username)
  return [`# ${author}`, "", `- URL: ${canonicalTarget.url}`, "", body].join("\n")
}

export class ThreadsLoader implements Loader {
  readonly timeoutMs: number
  readonly resources?: ResourceProvider

  constructor(options: { timeoutMs?: number; resources?: ResourceProvider } = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_THREADS_TIMEOUT_MS
    this.resources = options.resources
  }

  async load(url: string, signal?: AbortSignal): Promise<string> {
    const share = isThreadsShareUrl(url)
    if (share && !/^\/share\/[A-Za-z0-9_-]+\/?$/u.test(new URL(url).pathname)) {
      throw new LoaderContentError("ThreadsLoader", url, "Invalid Threads share link")
    }
    if (!share) parseThreadsTarget(url)
    const response = await fetchHttpHtml(url, {
      headers: {
        ...DEFAULT_HTTP_HEADERS,
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": THREADS_USER_AGENT,
      },
      resources: this.resources,
      signal,
      loaderName: "ThreadsLoader",
      timeoutMs: this.timeoutMs,
      maxBytes: MAX_THREADS_BYTES,
    })
    const mediaType = response.contentType.split(";", 1)[0]?.trim().toLowerCase() ?? ""
    if (mediaType && mediaType !== "text/html" && mediaType !== "application/xhtml+xml") {
      throw new LoaderContentError(
        "ThreadsLoader",
        url,
        `Expected HTML content, got: ${JSON.stringify(response.contentType)}`,
      )
    }
    if (share) {
      const finalUrl = response.finalUrl ?? url
      const finalShareMatches =
        isThreadsShareUrl(finalUrl) &&
        new URL(finalUrl).pathname.replace(/\/$/u, "") === new URL(url).pathname.replace(/\/$/u, "")
      if (
        new URL(finalUrl).username ||
        new URL(finalUrl).password ||
        (!isThreadsPostUrl(finalUrl) && !finalShareMatches)
      ) {
        throw new LoaderContentError("ThreadsLoader", url, "Share link left the requested post")
      }
      return extractThreadsSharePost(response.content, url, finalUrl)
    }
    return extractThreadsPost(response.content, parseThreadsTarget(url))
  }
}
