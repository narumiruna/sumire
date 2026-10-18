import type { AttemptRecord } from "./results.js"

export type FailureCode =
  | "captions_unavailable"
  | "caption_language_unavailable"
  | "captions_empty"
  | "caption_extraction_failed"
  | "media_duration_limit"
  | "media_size_limit"
  | "dependency_missing"
  | "metadata_failed"
  | "download_failed"
  | "transcription_failed"
  | "download_timeout"
  | "transcription_timeout"
  | "loader_timeout"
  | "target_http_error"
  | "service_http_error"
  | "transport_failure"
  | "tls_certificate"
  | "deadline_exceeded"
  | "cancelled"
  | "empty_content"
  | "configuration_missing"
  | "unknown"

export interface FailureDiagnostic {
  code: FailureCode
  phase?: "captions" | "metadata" | "download" | "transcription" | "loading" | "validation"
  limit?: number
  observed?: number
  dependency?: "yt-dlp" | "whisper" | "ffmpeg"
  httpStatus?: number
}

export class UrlContentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

export class LoaderError extends UrlContentError {
  constructor(
    public readonly url: string,
    public readonly details: readonly string[] = [],
    public readonly attempts: readonly AttemptRecord[] = [],
  ) {
    const attempted =
      details.length > 0 ? `\n\nAttempted loaders:\n  - ${details.join("\n  - ")}` : ""
    super(`Failed to load URL: ${url}${attempted}`)
  }
}

export class InvalidUrlError extends UrlContentError {
  constructor(
    public readonly url: string,
    public readonly expected: string,
  ) {
    super(`URL is not a ${expected} URL: ${url}`)
  }
}

export class ConfigurationError extends UrlContentError {}

export class MissingRequirementError extends ConfigurationError {
  constructor(public readonly requirements: readonly string[]) {
    super(`Missing required environment variable(s): ${requirements.join(", ")}`)
  }
}

export class FirecrawlApiKeyNotSetError extends ConfigurationError {
  constructor() {
    super("FIRECRAWL_API_KEY is not set.")
  }
}

export class MissingDependencyError extends UrlContentError {
  constructor(
    public readonly loaderName: string,
    public readonly dependency: string,
    public readonly hint: string,
    public readonly diagnostic?: FailureDiagnostic,
  ) {
    super(`Loader ${JSON.stringify(loaderName)} requires ${JSON.stringify(dependency)}. ${hint}`)
  }
}

export class LoaderNotApplicableError extends UrlContentError {
  constructor(
    public readonly loaderName: string,
    public readonly url: string,
    public readonly reason?: string,
  ) {
    super(`${loaderName} cannot handle URL: ${url}${reason ? ` - ${reason}` : ""}`)
  }
}

export class LoaderTimeoutError extends UrlContentError {
  constructor(
    public readonly loaderName: string,
    public readonly url: string,
    public readonly timeoutSeconds: number,
    public readonly suggestion = "Try increasing the timeout or check your network connection.",
    public readonly diagnostic?: FailureDiagnostic,
  ) {
    super(
      `${loaderName} timed out after ${timeoutSeconds}s while loading: ${url}\nSuggestion: ${suggestion}`,
    )
  }
}

export class LoaderContentError extends UrlContentError {
  constructor(
    public readonly loaderName: string,
    public readonly url: string,
    public readonly reason: string,
    public readonly suggestion?: string,
    cause?: unknown,
  ) {
    super(
      `${loaderName} failed to extract content from: ${url} - ${reason}${suggestion ? `\nSuggestion: ${suggestion}` : ""}`,
    )
    if (cause !== undefined) this.cause = cause
  }
}

/** A factual failure with a fixed reason; upstream text is not part of the diagnostic. */
export class FailureDiagnosticError extends LoaderContentError {
  constructor(
    loaderName: string,
    url: string,
    public readonly diagnostic: FailureDiagnostic,
  ) {
    super(loaderName, url, `Content loading failed (${diagnostic.code})`)
    this.message = this.reason
  }
}

export class TargetHttpError extends LoaderContentError {
  constructor(
    loaderName: string,
    url: string,
    public readonly status: number,
  ) {
    super(loaderName, url, `Target website returned HTTP ${status}`)
  }
}

export class FirecrawlApiHttpError extends LoaderContentError {
  constructor(
    url: string,
    public readonly status: number,
  ) {
    super("FirecrawlLoader", url, `Firecrawl API returned HTTP ${status}`)
  }
}

/** Classify typed facts only. An aggregate must be read through its ordered attempts. */
export function getFailureDiagnostic(error: unknown): FailureDiagnostic {
  if (
    error instanceof FailureDiagnosticError ||
    error instanceof LoaderTimeoutError ||
    error instanceof MissingDependencyError
  ) {
    if (error.diagnostic) return { ...error.diagnostic }
  }
  if (error instanceof LoaderTimeoutError) {
    return {
      code: "loader_timeout",
      phase: "loading",
      ...(Number.isFinite(error.timeoutSeconds) &&
      error.timeoutSeconds >= 0 &&
      error.timeoutSeconds <= Number.MAX_SAFE_INTEGER
        ? { limit: error.timeoutSeconds }
        : {}),
    }
  }
  if (error instanceof TargetHttpError || error instanceof FirecrawlApiHttpError) {
    return {
      code: error instanceof TargetHttpError ? "target_http_error" : "service_http_error",
      phase: "loading",
      ...(Number.isInteger(error.status) && error.status >= 100 && error.status <= 599
        ? { httpStatus: error.status }
        : {}),
    }
  }
  if (error instanceof ConfigurationError) return { code: "configuration_missing" }
  if (error instanceof MissingDependencyError) {
    const dependency = error.dependency
    return {
      code: "dependency_missing",
      ...(dependency === "yt-dlp" || dependency === "whisper" || dependency === "ffmpeg"
        ? { dependency }
        : {}),
    }
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return { code: "deadline_exceeded", phase: "loading" }
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return { code: "cancelled", phase: "loading" }
  }
  const cause = error instanceof Error ? error.cause : undefined
  if (isTlsFailure(error) || isTlsFailure(cause)) {
    return { code: "tls_certificate", phase: "loading" }
  }
  if (isTransportFailure(error) || isTransportFailure(cause)) {
    return { code: "transport_failure", phase: "loading" }
  }
  return { code: "unknown", phase: "loading" }
}

function isTlsFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "CertificateVerifyError" ||
      ("code" in error &&
        typeof error.code === "string" &&
        new Set([
          "CURLE_PEER_FAILED_VERIFICATION",
          "CERT_HAS_EXPIRED",
          "DEPTH_ZERO_SELF_SIGNED_CERT",
          "SELF_SIGNED_CERT_IN_CHAIN",
          "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
          "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
          "ERR_TLS_CERT_ALTNAME_INVALID",
        ]).has(error.code)))
  )
}

function isTransportFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    new Set([
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_SOCKET",
    ]).has(error.code)
  )
}
