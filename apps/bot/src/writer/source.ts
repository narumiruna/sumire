import type { PublicUrlLoader } from "@narumitw/sumire-url-tool"

const maxArticleUrls = 4
const urlPattern = /https?:\/\/[^\s<>"']+/giu

export interface ArticleUrlContent {
  url: string
  text: string
  truncated: boolean
}

export class TooManyArticleUrlsError extends Error {}

export async function loadArticleSourceUrls(
  source: string,
  loader: PublicUrlLoader,
  options: { maxChars: number; timeoutMs: number },
): Promise<ArticleUrlContent[]> {
  const urls = [
    ...new Set(
      [...source.matchAll(urlPattern)]
        .map(([url]) => url?.replace(/[.,;!?。，；！？]+$/u, "") ?? "")
        .filter(Boolean),
    ),
  ]
  const maxUrls = Math.min(maxArticleUrls, options.maxChars)
  if (urls.length > maxUrls) {
    throw new TooManyArticleUrlsError(`Only ${maxUrls} article URLs are supported`)
  }
  if (urls.length === 0) return []

  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs)])
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
