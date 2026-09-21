import { LoaderContentError, LoaderTimeoutError } from "../core/errors.js"
import type { Loader } from "../core/loader.js"
import { readResponseText, safeFetch } from "../core/network.js"
import type { ResourceProvider } from "../core/resources.js"
import { parseGoogleDocsTarget, requireLoaderApplicability } from "../sources/applicability.js"

export const DEFAULT_GOOGLE_DOCS_TIMEOUT_MS = 20_000
export const MAX_GOOGLE_DOCS_BYTES = 10 * 1024 * 1024

export class GoogleDocsLoader implements Loader {
  constructor(
    private readonly options: { resources?: ResourceProvider; timeoutMs?: number } = {},
  ) {}

  async load(url: string, signal?: AbortSignal): Promise<string> {
    const target = requireLoaderApplicability("GoogleDocsLoader", url, parseGoogleDocsTarget)
    if (signal?.aborted) throw signal.reason
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_GOOGLE_DOCS_TIMEOUT_MS
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const activeSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    try {
      const init: RequestInit = {
        headers: { Accept: "text/plain" },
        redirect: "follow",
        signal: activeSignal,
      }
      const response = await (this.options.resources?.fetch(target.exportUrl, init) ??
        safeFetch(target.exportUrl, init))
      if (!response.ok) {
        await response.body?.cancel()
        throw new LoaderContentError(
          "GoogleDocsLoader",
          url,
          `Google Docs export returned HTTP ${response.status}`,
          "The document must allow viewing and text export without signing in.",
        )
      }
      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase()
      if (contentType !== "text/plain") {
        await response.body?.cancel()
        throw new LoaderContentError(
          "GoogleDocsLoader",
          url,
          `Expected a plain-text export, got ${JSON.stringify(contentType ?? "unknown")}`,
          "The document must allow viewing and text export without signing in; login and editor pages are not document content.",
        )
      }
      const text = await readResponseText(response, MAX_GOOGLE_DOCS_BYTES)
      if (!text.trim()) {
        throw new LoaderContentError("GoogleDocsLoader", url, "Google Docs export is empty")
      }
      return text
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      if (timeoutSignal.aborted) {
        throw new LoaderTimeoutError("GoogleDocsLoader", url, timeoutMs / 1_000)
      }
      throw error
    }
  }
}
