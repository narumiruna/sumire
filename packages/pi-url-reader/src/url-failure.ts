import {
  type AttemptRecord,
  type FailureCode,
  type FailureDiagnostic,
  getFailureDiagnostic,
  getInterruptedAttempts,
  InvalidUrlError,
  LoaderError,
  listLoaderNames,
} from "@narumitw/sumire-url-reader"

export type UrlFailureCode =
  | FailureCode
  | "invalid_url"
  | "unsafe_url"
  | "unsupported_content_type"
  | "response_size_limit"
  | "redirect_limit"

export interface SafeFailureDiagnostic extends Omit<FailureDiagnostic, "code"> {
  code: UrlFailureCode
}

export interface SafeFailureAttempt {
  loaderId: string
  status: AttemptRecord["status"]
  elapsedSeconds?: number
  diagnostic?: SafeFailureDiagnostic
}

export interface UrlFailure {
  code: UrlFailureCode
  attempts: readonly SafeFailureAttempt[]
  diagnostic?: SafeFailureDiagnostic
}

const failureCodes = new Set<UrlFailureCode>([
  "captions_unavailable",
  "caption_language_unavailable",
  "captions_empty",
  "caption_extraction_failed",
  "media_duration_limit",
  "media_size_limit",
  "dependency_missing",
  "metadata_failed",
  "download_failed",
  "transcription_failed",
  "download_timeout",
  "transcription_timeout",
  "loader_timeout",
  "service_http_error",
  "target_http_error",
  "transport_failure",
  "tls_certificate",
  "deadline_exceeded",
  "cancelled",
  "empty_content",
  "configuration_missing",
  "unknown",
  "invalid_url",
  "unsafe_url",
  "unsupported_content_type",
  "response_size_limit",
  "redirect_limit",
])
const phases = new Set([
  "captions",
  "metadata",
  "download",
  "transcription",
  "loading",
  "validation",
])
const dependencies = new Set(["yt-dlp", "whisper", "ffmpeg"])
const statuses = new Set<string>([
  "success",
  "failed",
  "skipped",
  "not_applicable",
  "timeout",
  "cancelled",
  "empty",
  "rejected",
])
const loaderIds = new Set([...listLoaderNames(), "built-in", "validation", "unknown"])
const maxAttempts = 32
const maxErrors = 64
const maxDepth = 8

/** A typed failure produced by this package, not an upstream error-message classifier. */
export class PublicUrlError extends Error {
  constructor(
    public readonly code: UrlFailureCode,
    message: string,
    phase: "loading" | "validation" = "validation",
    public readonly diagnostic: SafeFailureDiagnostic = { code, phase },
  ) {
    super(message)
    this.name = "PublicUrlError"
  }
}

/** Copy only bounded diagnostic facts. Never copy messages, URLs, paths, or arbitrary identifiers. */
export function sanitizeUrlAttempts(attempts: unknown): readonly SafeFailureAttempt[] {
  if (!Array.isArray(attempts)) return []
  const safe: SafeFailureAttempt[] = []
  for (const attempt of attempts.slice(0, maxAttempts)) {
    const status = field(attempt, "status")
    if (typeof status !== "string" || !statuses.has(status)) continue
    const loaderId = field(attempt, "loaderId")
    const elapsedSeconds = field(attempt, "elapsedSeconds")
    const diagnostic = field(attempt, "diagnostic")
    const facts =
      diagnostic !== undefined
        ? sanitizeDiagnostic(diagnostic)
        : legacyDiagnostic(field(attempt, "errorCode"))
    safe.push({
      loaderId: typeof loaderId === "string" && loaderIds.has(loaderId) ? loaderId : "unknown",
      status: status as AttemptRecord["status"],
      ...(safeNumber(elapsedSeconds) ? { elapsedSeconds } : {}),
      ...(facts ? { diagnostic: facts } : {}),
    })
  }
  return safe
}

/** Normalize at the user/tool boundary; raw exceptions remain available to internal callers. */
export function normalizeUrlFailure(error: unknown, url?: string): UrlFailure {
  const attempts: SafeFailureAttempt[] = []
  const diagnostics: SafeFailureDiagnostic[] = []
  const seen = new Set<unknown>()
  const pending = [{ error, depth: 0 }]
  for (let visited = 0; pending.length > 0 && visited < maxErrors; visited += 1) {
    const current = pending.pop()
    if (!current || seen.has(current.error)) continue
    seen.add(current.error)
    const value = current.error
    if (value instanceof LoaderError && url !== undefined && field(value, "url") !== url) continue
    const interrupted =
      value instanceof LoaderError ? undefined : getInterruptedAttempts(value, url)
    const retained = sanitizeUrlAttempts(interrupted)
    attempts.push(...retained)
    if (value instanceof LoaderError)
      attempts.push(...sanitizeUrlAttempts(field(value, "attempts")))
    if (value instanceof InvalidUrlError) {
      diagnostics.push({ code: "invalid_url", phase: "validation" })
    } else if (value instanceof PublicUrlError) {
      const diagnostic = sanitizeDiagnostic(field(value, "diagnostic"))
      diagnostics.push({ ...diagnostic, code: safeCode(field(value, "code")) })
    } else {
      const diagnostic = classifySafely(value)
      diagnostics.push(
        retained.some((attempt) => attempt.status === "cancelled") && diagnostic.code === "unknown"
          ? { ...diagnostic, code: "cancelled" }
          : diagnostic,
      )
    }
    if (current.depth >= maxDepth) continue
    if (value instanceof AggregateError) {
      const errors = field(value, "errors")
      if (Array.isArray(errors)) {
        for (const child of errors.slice(0, maxErrors).reverse()) {
          if (pending.length >= maxErrors) break
          pending.push({ error: child, depth: current.depth + 1 })
        }
      }
    }
  }
  const boundedAttempts = attempts.slice(0, maxAttempts)
  const interruption = diagnostics.find(
    ({ code }) => code === "deadline_exceeded" || code === "cancelled",
  )
  const failedAttempts = boundedAttempts.filter(
    (attempt) => attempt.status !== "success" && attempt.status !== "not_applicable",
  )
  const usefulAttempt = failedAttempts.findLast(
    (attempt) =>
      attempt.status !== "skipped" &&
      attempt.diagnostic !== undefined &&
      !["unknown", "configuration_missing", "cancelled"].includes(attempt.diagnostic.code),
  )
  const diagnostic =
    interruption ??
    usefulAttempt?.diagnostic ??
    diagnostics.find(({ code }) => code !== "unknown") ??
    failedAttempts.findLast((attempt) => attempt.diagnostic)?.diagnostic
  return {
    code: diagnostic?.code ?? "unknown",
    attempts: boundedAttempts,
    ...(diagnostic ? { diagnostic } : {}),
  }
}

function classifySafely(error: unknown): SafeFailureDiagnostic {
  try {
    return sanitizeDiagnostic(getFailureDiagnostic(error))
  } catch {
    // Malformed upstream fields, including accessors, are not safe evidence.
    return { code: "unknown" }
  }
}

function sanitizeDiagnostic(value: unknown): SafeFailureDiagnostic {
  const phase = field(value, "phase")
  const dependency = field(value, "dependency")
  const limit = field(value, "limit")
  const observed = field(value, "observed")
  const httpStatus = field(value, "httpStatus")
  return {
    code: safeCode(field(value, "code")),
    ...(typeof phase === "string" && phases.has(phase)
      ? { phase: phase as FailureDiagnostic["phase"] }
      : {}),
    ...(safeNumber(limit) ? { limit } : {}),
    ...(safeNumber(observed) ? { observed } : {}),
    ...(typeof dependency === "string" && dependencies.has(dependency)
      ? { dependency: dependency as FailureDiagnostic["dependency"] }
      : {}),
    ...(typeof httpStatus === "number" &&
    Number.isInteger(httpStatus) &&
    httpStatus >= 100 &&
    httpStatus <= 599
      ? { httpStatus }
      : {}),
  }
}

// Compatibility for existing structured provenance codes, not upstream message text.
function legacyDiagnostic(code: unknown): SafeFailureDiagnostic | undefined {
  if (code === "tls_certificate" || code === "transport_failure") return { code, phase: "loading" }
  if (typeof code !== "string") return undefined
  const match = /^(target|firecrawl_api)_http_([1-5]\d\d)$/u.exec(code)
  if (!match) return undefined
  return {
    code: match[1] === "target" ? "target_http_error" : "service_http_error",
    phase: "loading",
    httpStatus: Number(match[2]),
  }
}

function safeCode(value: unknown): UrlFailureCode {
  return typeof value === "string" && failureCodes.has(value as UrlFailureCode)
    ? (value as UrlFailureCode)
    : "unknown"
}

function safeNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER
  )
}

// Ignore accessors: malformed metadata must not execute code during normalization.
function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined
  return Object.getOwnPropertyDescriptor(value, key)?.value
}
