import {
  FailureDiagnosticError,
  FirecrawlApiHttpError,
  FirecrawlApiKeyNotSetError,
  getFailureDiagnostic,
  LoaderContentError,
  LoaderTimeoutError,
} from "../core/errors.js"
import { redactFirecrawlCredential, resolveFirecrawlApiKey } from "../core/firecrawl-credentials.js"
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

  constructor(
    options: { apiKey?: string | null; timeoutMs?: number; resources?: ResourceProvider } = {},
  ) {
    const apiKey = resolveFirecrawlApiKey(options.apiKey)
    if (!apiKey) throw new FirecrawlApiKeyNotSetError()
    this.apiKey = apiKey
    this.timeoutMs = options.timeoutMs ?? DEFAULT_FIRECRAWL_TIMEOUT_MS
    this.resources = options.resources
  }

  async load(url: string, signal?: AbortSignal): Promise<string> {
    // Keep the credential and its redactor local until response processing ends.
    const apiKey = this.apiKey
    const redact = (value: string) => redactFirecrawlCredential(value, apiKey)
    const safeUrl = redact(url)
    const safeErrors = new Set<Error>()
    const safeError = <T extends Error>(error: T): T => {
      safeErrors.add(error)
      return error
    }
    const contentError = (reason: string) =>
      safeError(new LoaderContentError("FirecrawlLoader", safeUrl, reason))
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs)
    const activeSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    try {
      const init = {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url, formats: ["markdown"], timeout: this.timeoutMs }),
        signal: activeSignal,
      }
      const response = await (this.resources?.fetch("https://api.firecrawl.dev/v1/scrape", init) ??
        fetch("https://api.firecrawl.dev/v1/scrape", init))
      if (!response.ok) {
        await response.body?.cancel()
        throw safeError(new FirecrawlApiHttpError(safeUrl, response.status))
      }
      const payload = JSON.parse(
        await readResponseText(response, MAX_FIRECRAWL_BYTES, activeSignal),
      ) as Record<string, unknown>
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw contentError("Firecrawl returned an invalid response envelope")
      }
      if (payload.success === false) throw contentError("Firecrawl scrape was unsuccessful")
      const data =
        payload.data && typeof payload.data === "object"
          ? (payload.data as Record<string, unknown>)
          : payload
      if (typeof data.markdown !== "string") {
        throw contentError("Firecrawl scrape result did not include markdown")
      }
      const metadata = data.metadata
      if (metadata && typeof metadata === "object") {
        for (const field of ["url", "sourceURL"]) {
          const target = (metadata as Record<string, unknown>)[field]
          if (typeof target === "string") {
            try {
              if (this.resources) await this.resources.validateUrl(target, activeSignal)
              else await assertPublicUrl(target, { signal: activeSignal })
            } catch {
              throw contentError("Firecrawl returned an unsafe final URL")
            }
          }
        }
      }
      const markdown = redact(data.markdown)
      try {
        ensureUsableContent(markdown, { loaderName: "FirecrawlLoader", url: safeUrl })
      } catch {
        throw contentError("Firecrawl returned blocked or empty content")
      }
      return markdown
    } catch (error) {
      if (timeoutSignal.aborted)
        throw new LoaderTimeoutError("FirecrawlLoader", safeUrl, this.timeoutMs / 1_000)
      if (signal?.aborted) throw new DOMException("Firecrawl request cancelled", "AbortError")
      if (error instanceof Error && safeErrors.has(error)) throw error
      // Preserve only typed transport facts, never upstream fields or causes.
      let code: string | undefined
      try {
        code = getFailureDiagnostic(error).code
      } catch {
        // An exception with unsafe accessors is not a trusted diagnostic.
      }
      if (code === "tls_certificate" || code === "transport_failure") {
        throw new FailureDiagnosticError("FirecrawlLoader", safeUrl, { code, phase: "loading" })
      }
      throw contentError("Firecrawl request failed")
    }
  }
}
