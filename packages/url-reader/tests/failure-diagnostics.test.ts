import { describe, expect, it } from "vitest"

import {
  ConfigurationError,
  FailureDiagnosticError,
  FirecrawlApiHttpError,
  getFailureDiagnostic,
  LoaderContentError,
  LoaderTimeoutError,
  MissingDependencyError,
  TargetHttpError,
} from "../src/core/errors.js"
import { attemptRecordToObject, loadResultToObject } from "../src/core/results.js"

const url = "https://example.com/video"

describe("failure diagnostic contract", () => {
  it("keeps typed content errors compatible and excludes upstream text from the message", () => {
    const diagnostic = {
      code: "media_duration_limit",
      phase: "metadata",
      limit: 3600,
      observed: 5198,
    } as const
    const error = new FailureDiagnosticError(
      "YtdlpLoader",
      "https://user:password@example.com/?token=secret",
      diagnostic,
    )
    expect(error).toBeInstanceOf(LoaderContentError)
    expect(error.url).toContain("token=secret")
    expect(error.message).toBe("Content loading failed (media_duration_limit)")
    expect(getFailureDiagnostic(error)).toEqual(diagnostic)
    expect(getFailureDiagnostic(error)).not.toBe(error.diagnostic)
  })

  it("retains timeout and missing-dependency class identities", () => {
    const timeout = new LoaderTimeoutError("YtdlpLoader", url, 10, "Timed out", {
      code: "download_timeout",
      phase: "download",
    })
    const missing = new MissingDependencyError("ytdlp", "whisper", "Install Whisper", {
      code: "dependency_missing",
      dependency: "whisper",
      phase: "transcription",
    })
    expect(getFailureDiagnostic(timeout)).toEqual({ code: "download_timeout", phase: "download" })
    expect(getFailureDiagnostic(missing)).toEqual({
      code: "dependency_missing",
      dependency: "whisper",
      phase: "transcription",
    })
    expect(getFailureDiagnostic(new LoaderTimeoutError("OtherLoader", url, 10))).toEqual({
      code: "loader_timeout",
      phase: "loading",
      limit: 10,
    })
    expect(
      getFailureDiagnostic(new MissingDependencyError("ytdlp", "/private/bin/whisper", "hint")),
    ).toEqual({ code: "dependency_missing" })
  })

  it("does not confuse API HTTP errors with target HTTP errors", () => {
    expect(getFailureDiagnostic(new TargetHttpError("HttpLoader", url, 403))).toEqual({
      code: "target_http_error",
      phase: "loading",
      httpStatus: 403,
    })
    expect(getFailureDiagnostic(new TargetHttpError("HttpLoader", url, Number.NaN))).toEqual({
      code: "target_http_error",
      phase: "loading",
    })
    expect(getFailureDiagnostic(new FirecrawlApiHttpError(url, 403))).toEqual({
      code: "service_http_error",
      phase: "loading",
      httpStatus: 403,
    })
    expect(getFailureDiagnostic(new ConfigurationError("private configuration"))).toEqual({
      code: "configuration_missing",
    })
  })

  it.each([
    ["ECONNRESET", "transport_failure"],
    ["ENOTFOUND", "transport_failure"],
    ["CERT_HAS_EXPIRED", "tls_certificate"],
    ["CURLE_PEER_FAILED_VERIFICATION", "tls_certificate"],
  ])("classifies structured system code %s", (code, expected) => {
    const cause = Object.assign(new Error("private data"), { code })
    expect(getFailureDiagnostic(cause)).toEqual({ code: expected, phase: "loading" })
    expect(getFailureDiagnostic(new Error("fetch failed", { cause }))).toEqual({
      code: expected,
      phase: "loading",
    })
  })

  it.each([
    new Error("HTTP 403; CERT_HAS_EXPIRED; dependency missing; captions disabled"),
    Object.assign(new Error("secret"), { name: "TimeoutError" }),
    new LoaderContentError("CurlCffiLoader", url, "Unsupported content type"),
    new LoaderContentError("CurlCffiLoader", url, "Response is too large"),
    new LoaderContentError("CurlCffiLoader", url, "Empty content"),
    { diagnostic: { code: "media_duration_limit", observed: 5198 }, status: 403 },
    { name: "FailureDiagnosticError", code: "ENOENT" },
    "cancelled",
    undefined,
  ])("does not infer facts from arbitrary errors or object shape (fixture %#)", (error) => {
    expect(getFailureDiagnostic(error)).toEqual({ code: "unknown", phase: "loading" })
  })

  it("distinguishes typed cancellation from a shared deadline", () => {
    expect(getFailureDiagnostic(new DOMException("private details", "AbortError"))).toEqual({
      code: "cancelled",
      phase: "loading",
    })
    expect(getFailureDiagnostic(new DOMException("private details", "TimeoutError"))).toEqual({
      code: "deadline_exceeded",
      phase: "loading",
    })
  })

  it("serializes additive facts and keeps all existing result fields", () => {
    const attempt = {
      loaderId: "httpx",
      status: "failed",
      elapsedSeconds: 0.5,
      errorType: "TargetHttpError",
      errorCode: "target_http_403",
      message: "Content extraction failed",
      diagnostic: { code: "target_http_error", phase: "loading", httpStatus: 403 },
    } as const
    const serialized = {
      loader_id: "httpx",
      status: "failed",
      elapsed_seconds: 0.5,
      error_type: "TargetHttpError",
      error_code: "target_http_403",
      message: "Content extraction failed",
      diagnostic: { code: "target_http_error", phase: "loading", httpStatus: 403 },
    }
    expect(attemptRecordToObject(attempt)).toEqual(serialized)
    expect(
      loadResultToObject({
        content: "content",
        loaderId: "other",
        contentType: "generic_web",
        downgraded: false,
        attempts: [attempt],
      }),
    ).toEqual({
      content: "content",
      loader_id: "other",
      content_type: "generic_web",
      downgraded: false,
      attempts: [serialized],
    })
    expect(
      attemptRecordToObject({ loaderId: "other", status: "success", elapsedSeconds: 0 }).diagnostic,
    ).toBeNull()
  })
})
