import { createHmac, randomBytes } from "node:crypto"

import { type AttemptRecord, getLoaderDef, LoaderError } from "@narumitw/sumire-url-content"
import type { LoadedUrl } from "@narumitw/sumire-url-tool"

import { type Logger, withLogSpan } from "./logging.js"

// A process-local key prevents offline guessing of private URL paths or query parameters.
const fingerprintKey = randomBytes(32)

export function urlFingerprint(value: string): string {
  return createHmac("sha256", fingerprintKey).update(value).digest("hex")
}

export function singleUrlFingerprint(text: string): string | undefined {
  if (!/^https?:\/\//iu.test(text)) return undefined
  try {
    const url = new URL(text)
    if (url.username || url.password || /\s/u.test(text)) return undefined
    return urlFingerprint(text)
  } catch {
    return undefined
  }
}

export function traceUrlLoad(
  logger: Logger,
  url: string,
  requestedLoader: string | undefined,
  toolCallId: string,
  load: () => Promise<LoadedUrl>,
): Promise<LoadedUrl> {
  return withLogSpan(
    logger,
    "url.load",
    {
      "url.fingerprint": urlFingerprint(url),
      "url.requested_loader": requestedLoader ?? "auto",
      "pi.tool_call_id": toolCallId,
    },
    async (span) => {
      try {
        const result = await load()
        span.setAttribute("url.outcome", "success")
        span.setAttribute("url.source", result.source)
        span.setAttribute("url.loader", result.loaderId ?? "none")
        span.setAttribute("url.truncated", result.truncated)
        span.setAttribute("url.content_chars", result.text.length)
        recordAttempts(span, result.attempts)
        if (result.status !== undefined) span.setAttribute("url.http_status", result.status)
        const host = loadedUrlHost(result.finalUrl)
        if (host) {
          span.setAttribute("url.host", host)
          span.setAttribute("url.final_fingerprint", urlFingerprint(result.finalUrl))
        }
        return result
      } catch (error) {
        span.setAttribute("url.outcome", "error")
        span.setAttribute("url.error_type", safeErrorType(error))
        recordAttempts(span, errorAttempts(error))
        throw error
      }
    },
  )
}

const attemptStatuses = new Set([
  "success",
  "failed",
  "skipped",
  "not_applicable",
  "timeout",
  "empty",
  "rejected",
])
const safeErrorTypes = new Set([
  "LoaderContentError",
  "LoaderError",
  "AggregateError",
  "FirecrawlApiHttpError",
  "TargetHttpError",
  "AbortError",
  "LoaderTimeoutError",
  "LoaderNotApplicableError",
  "TimeoutError",
  "MissingRequirementError",
  "TypeError",
  "Error",
])

function safeErrorType(error: unknown): string {
  return error instanceof Error ? safeErrorName(error.name) : "other"
}

function safeErrorName(name: string | undefined): string {
  return name && safeErrorTypes.has(name) ? name : "other"
}

function errorAttempts(error: unknown): readonly AttemptRecord[] | undefined {
  if (error instanceof LoaderError) return error.attempts
  if (error instanceof AggregateError) {
    for (const nested of error.errors as unknown[]) {
      const attempts = errorAttempts(nested)
      if (attempts?.length) return attempts
    }
  }
  return undefined
}

function recordAttempts(
  span: { setAttribute(key: string, value: string): void },
  attempts:
    | readonly Pick<AttemptRecord, "loaderId" | "status" | "errorType" | "errorCode">[]
    | undefined,
): void {
  if (!attempts?.length) return
  const safe = attempts.slice(0, 24).flatMap((attempt) => {
    try {
      getLoaderDef(attempt.loaderId)
    } catch {
      return []
    }
    if (!attemptStatuses.has(attempt.status)) return []
    const code = attempt.errorCode
    return [
      {
        loader: attempt.loaderId,
        status: attempt.status,
        ...(attempt.errorType ? { errorType: safeErrorName(attempt.errorType) } : {}),
        ...(code === "tls_certificate" ||
        code === "transport_failure" ||
        /^(?:firecrawl_api|target)_http_[1-5]\d\d$/u.test(code ?? "")
          ? { code }
          : {}),
      },
    ]
  })
  if (safe.length) span.setAttribute("url.attempts", JSON.stringify(safe))
}

export function loadedUrlHost(value: string): string | undefined {
  try {
    const url = new URL(value)
    return /^https?:$/u.test(url.protocol) && !url.username && !url.password
      ? url.hostname.slice(0, 253)
      : undefined
  } catch {
    return undefined
  }
}
