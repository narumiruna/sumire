import type { PublicUrlLoader } from "@narumitw/sumire-url-tool"

const maxArticleUrls = 4
const urlPattern = /https?:\/\/[^\s<>"]+/giu
const trailingPunctuation = /[.,;!?。，；！？]+$/u
const closingWrappers = new Map([
  ["'", /'[.,;!?。，；！？]*$/u],
  ["`", /`[.,;!?。，；！？]*$/u],
  ["「", /」[.,;!?。，；！？]*$/u],
  ["“", /”[.,;!?。，；！？]*$/u],
])
const closingDelimiters = new Map([
  [")", "("],
  ["]", "["],
  ["）", "（"],
])

function hasUnmatchedClosingDelimiter(value: string): boolean {
  const closing = value.at(-1) ?? ""
  const opening = closingDelimiters.get(closing)
  return opening !== undefined && value.split(closing).length > value.split(opening).length
}

function trimUrlEnd(value: string): string {
  let url = value
  while (url) {
    // Bare punctuation can be part of a URL; only strip it outside an unmatched wrapper.
    const withoutPunctuation = url.replace(trailingPunctuation, "")
    if (withoutPunctuation !== url && hasUnmatchedClosingDelimiter(withoutPunctuation)) {
      url = withoutPunctuation
      continue
    }
    if (!hasUnmatchedClosingDelimiter(url)) break
    url = url.slice(0, -1)
  }
  return url
}

export interface ArticleUrlContent {
  url: string
  text: string
  truncated: boolean
}

export class TooManyArticleUrlsError extends Error {}
export class ArticleUrlBudgetError extends Error {}

export async function loadArticleSourceUrls(
  source: string,
  loader: PublicUrlLoader,
  options: { maxChars: number; timeoutMs: number; signal?: AbortSignal },
): Promise<ArticleUrlContent[]> {
  const urls = [
    ...new Set(
      [...source.matchAll(urlPattern)]
        .map((match) => {
          const url = trimUrlEnd(match[0])
          const wrapper = closingWrappers.get(source[(match.index ?? 0) - 1] ?? "")
          return wrapper ? url.replace(wrapper, "") : url
        })
        .filter(Boolean),
    ),
  ]
  if (urls.length > maxArticleUrls) {
    throw new TooManyArticleUrlsError(`Only ${maxArticleUrls} article URLs are supported`)
  }
  if (urls.length === 0) return []
  if (options.maxChars < urls.length) {
    throw new ArticleUrlBudgetError("Article URL content budget is too small")
  }

  const controller = new AbortController()
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(options.timeoutMs),
    ...(options.signal ? [options.signal] : []),
  ])
  if (signal.aborted) throw signal.reason
  try {
    const results = await Promise.race([
      Promise.all(urls.map((url) => loader.load(url, { signal }))),
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      }),
    ])
    const share = Math.floor(options.maxChars / results.length)
    const allocated = results.map((result) => Math.min(share, result.text.length))
    let remaining = options.maxChars - allocated.reduce((sum, chars) => sum + chars, 0)
    return results.map((result, index) => {
      const base = allocated[index] ?? 0
      const extra = Math.min(remaining, result.text.length - base)
      remaining -= extra
      const charLimit = base + extra
      return {
        url: result.url,
        text: result.text.slice(0, charLimit),
        truncated: result.truncated || result.text.length > charLimit,
      }
    })
  } finally {
    controller.abort()
  }
}
