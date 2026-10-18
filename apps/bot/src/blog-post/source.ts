import {
  normalizeUrlFailure,
  type PublicUrlLoader,
  type UrlFailure,
} from "@narumitw/sumire-pi-url-reader"

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

export class ArticleSourceUrlError extends Error {
  constructor(
    public readonly failure: UrlFailure,
    public readonly sourceIndex?: number,
  ) {
    super("Article source loading failed")
    this.name = "ArticleSourceUrlError"
  }
}

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
  const timeoutFailure = () => {
    const recorded = urls.map((url, index) => ({
      failure: normalizeUrlFailure(signal.reason, url),
      sourceIndex: index + 1,
    }))
    const source = recorded.find(({ failure }) => failure.attempts.length > 0)
    return source
      ? new ArticleSourceUrlError(source.failure, source.sourceIndex)
      : new ArticleSourceUrlError(
          normalizeUrlFailure(signal.reason, urls[0]),
          urls.length === 1 ? 1 : undefined,
        )
  }
  let onAbort: (() => void) | undefined
  let abortFallback: ReturnType<typeof setImmediate> | undefined
  try {
    const results = await Promise.race([
      Promise.all(
        urls.map(async (url, index) => {
          try {
            return await loader.load(url, { signal })
          } catch (error) {
            if (options.signal?.aborted) throw options.signal.reason
            // Capture the source and its diagnostics before finally cancels siblings.
            throw new ArticleSourceUrlError(normalizeUrlFailure(error, url), index + 1)
          }
        }),
      ),
      new Promise<never>((_, reject) => {
        onAbort = () => {
          if (options.signal?.aborted) {
            reject(options.signal.reason)
            return
          }
          // Allow cooperative loaders to retain their attempts and source position.
          // An abort-ignoring loader still stops waiting after this event-loop turn.
          abortFallback = setImmediate(() => reject(timeoutFailure()))
        }
        signal.addEventListener("abort", onAbort, { once: true })
        if (signal.aborted) onAbort()
      }),
    ])
    if (options.signal?.aborted) throw options.signal.reason
    if (signal.aborted) throw timeoutFailure()
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
    if (onAbort) signal.removeEventListener("abort", onAbort)
    if (abortFallback) clearImmediate(abortFallback)
    controller.abort()
  }
}
