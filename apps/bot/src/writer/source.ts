import type { PublicUrlLoader } from "@narumitw/sumire-url-tool"

const maxArticleUrls = 4
const urlPattern = /https?:\/\/[^\s<>"']+/giu
const trailingPunctuation = /[.,;!?。，；！？]/u
const closingDelimiters = new Map([
  [")", "("],
  ["]", "["],
  ["）", "（"],
])

function trimUrlEnd(value: string): string {
  let url = value
  while (url) {
    const last = url.at(-1) ?? ""
    if (trailingPunctuation.test(last)) {
      url = url.slice(0, -1)
      continue
    }
    const opening = closingDelimiters.get(last)
    if (!opening || url.split(last).length <= url.split(opening).length) break
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
      [...source.matchAll(urlPattern)].map(([url]) => trimUrlEnd(url ?? "")).filter(Boolean),
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
    return await Promise.race([
      Promise.all(
        urls.map(async (url) => {
          const result = await loader.load(url, { signal })
          const charLimit = Math.floor(options.maxChars / urls.length)
          return {
            url,
            text: result.text.slice(0, charLimit),
            truncated: result.truncated || result.text.length > charLimit,
          }
        }),
      ),
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      }),
    ])
  } finally {
    controller.abort()
  }
}
