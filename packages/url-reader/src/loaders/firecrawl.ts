import {
  FirecrawlApiHttpError,
  FirecrawlApiKeyNotSetError,
  LoaderContentError,
  LoaderTimeoutError,
} from "../core/errors.js"
import type { Loader } from "../core/loader.js"
import { assertPublicUrl, readResponseText } from "../core/network.js"
import type { ResourceProvider } from "../core/resources.js"
import { ensureUsableContent } from "./content-guard.js"

export const DEFAULT_FIRECRAWL_TIMEOUT_MS = 30_000
export const MAX_FIRECRAWL_BYTES = 10 * 1024 * 1024

export class FirecrawlLoader implements Loader {
  readonly apiKey: string
  readonly timeoutMs: number
  readonly resources?: ResourceProvider

  constructor(options: { apiKey?: string; timeoutMs?: number; resources?: ResourceProvider } = {}) {
    const apiKey = options.apiKey ?? process.env.FIRECRAWL_API_KEY
    if (!apiKey) throw new FirecrawlApiKeyNotSetError()
    this.apiKey = apiKey
    this.timeoutMs = options.timeoutMs ?? DEFAULT_FIRECRAWL_TIMEOUT_MS
    this.resources = options.resources
  }

  async load(url: string, signal?: AbortSignal): Promise<string> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs)
    const activeSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    try {
      const response = await (this.resources?.fetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url, formats: ["markdown"], timeout: this.timeoutMs }),
        signal: activeSignal,
      }) ??
        fetch("https://api.firecrawl.dev/v1/scrape", {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ url, formats: ["markdown"], timeout: this.timeoutMs }),
          signal: activeSignal,
        }))
      if (!response.ok) {
        await response.body?.cancel()
        throw new FirecrawlApiHttpError(url, response.status)
      }
      const payload = JSON.parse(
        await readResponseText(response, MAX_FIRECRAWL_BYTES, activeSignal),
      ) as Record<string, unknown>
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new LoaderContentError(
          "FirecrawlLoader",
          url,
          "Firecrawl returned an invalid response envelope",
        )
      }
      if (payload.success === false)
        throw new LoaderContentError("FirecrawlLoader", url, "Firecrawl scrape was unsuccessful")
      const data =
        payload.data && typeof payload.data === "object"
          ? (payload.data as Record<string, unknown>)
          : payload
      if (typeof data.markdown !== "string") {
        throw new LoaderContentError(
          "FirecrawlLoader",
          url,
          "Firecrawl scrape result did not include markdown",
        )
      }
      const metadata = data.metadata
      if (metadata && typeof metadata === "object") {
        for (const field of ["url", "sourceURL"]) {
          const target = (metadata as Record<string, unknown>)[field]
          if (typeof target === "string") {
            if (this.resources) await this.resources.validateUrl(target, activeSignal)
            else await assertPublicUrl(target, { signal: activeSignal })
          }
        }
      }
      ensureUsableContent(data.markdown, { loaderName: "FirecrawlLoader", url })
      return data.markdown
    } catch (error) {
      if (timeoutSignal.aborted)
        throw new LoaderTimeoutError("FirecrawlLoader", url, this.timeoutMs / 1_000)
      throw error
    }
  }
}
