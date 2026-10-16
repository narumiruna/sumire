import { DocumentConversionError, runAnyDocChild } from "../core/anydoc.js"
import { LoaderContentError, LoaderTimeoutError } from "../core/errors.js"
import type { Loader } from "../core/loader.js"
import { readResponseBytes, safeFetch } from "../core/network.js"
import type { ResourceProvider } from "../core/resources.js"
import { parseAnyDocTarget, requireLoaderApplicability } from "../sources/applicability.js"

export const DEFAULT_ANYDOC_TIMEOUT_MS = 30_000
export const MAX_ANYDOC_BYTES = 20_000_000
export const MAX_ANYDOC_MARKDOWN_CHARS = 1_000_000

const acceptedContentTypes = new Set([
  "",
  "application/octet-stream",
  "application/zip",
  "application/msword",
  "application/rtf",
  "text/rtf",
  "application/pdf",
  "application/epub+zip",
  "text/csv",
  "application/csv",
  "text/plain",
])
const officeContentTypePrefixes = [
  "application/vnd.openxmlformats-officedocument.",
  "application/vnd.ms-",
  "application/vnd.oasis.opendocument.",
]

export class AnyDocLoader implements Loader {
  constructor(
    private readonly options: { resources?: ResourceProvider; timeoutMs?: number } = {},
  ) {}

  async load(url: string, signal?: AbortSignal): Promise<string> {
    const target = requireLoaderApplicability("AnyDocLoader", url, parseAnyDocTarget)
    if (signal?.aborted) throw signal.reason
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_ANYDOC_TIMEOUT_MS
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const activeSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    try {
      const init: RequestInit = { redirect: "follow", signal: activeSignal }
      const response = await (this.options.resources?.fetch(url, init) ?? safeFetch(url, init))
      if (!response.ok) {
        await response.body?.cancel()
        throw new LoaderContentError(
          "AnyDocLoader",
          url,
          `Document returned HTTP ${response.status}`,
        )
      }
      const contentType =
        response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? ""
      if (
        !acceptedContentTypes.has(contentType) &&
        !officeContentTypePrefixes.some((prefix) => contentType.startsWith(prefix))
      ) {
        await response.body?.cancel()
        throw new LoaderContentError(
          "AnyDocLoader",
          url,
          `Expected a document response, got ${JSON.stringify(contentType)}`,
        )
      }
      const bytes = await readResponseBytes(response, MAX_ANYDOC_BYTES)
      if (bytes.byteLength === 0) {
        throw new LoaderContentError("AnyDocLoader", url, "The document is empty")
      }
      const result = await runAnyDocChild(
        bytes,
        target.filename,
        MAX_ANYDOC_MARKDOWN_CHARS,
        timeoutMs,
        activeSignal,
      )
      if (!result.ok) {
        throw new LoaderContentError(
          "AnyDocLoader",
          url,
          `AnyDoc conversion failed (${result.code}): ${result.message}`,
        )
      }
      if (!result.markdown.trim()) {
        throw new LoaderContentError("AnyDocLoader", url, "The document produced no Markdown")
      }
      return result.truncated
        ? `${result.markdown}\n\n[truncated by anydoc: ${result.originalChars} -> ${MAX_ANYDOC_MARKDOWN_CHARS} chars]`
        : result.markdown
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      if (
        timeoutSignal.aborted ||
        (error instanceof DocumentConversionError && error.kind === "timeout")
      ) {
        throw new LoaderTimeoutError("AnyDocLoader", url, timeoutMs / 1_000)
      }
      throw error
    }
  }
}
