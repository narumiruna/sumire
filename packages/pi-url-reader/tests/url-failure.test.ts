import {
  type AttemptRecord,
  FailureDiagnosticError,
  FirecrawlApiHttpError,
  InvalidUrlError,
  LoaderError,
  LoaderTimeoutError,
  resolveExplicitLoadChain,
  TargetHttpError,
} from "@narumitw/sumire-url-reader"
import { describe, expect, it } from "vitest"

import { normalizeUrlFailure, PublicUrlError, sanitizeUrlAttempts } from "../src/index.js"

const url = "https://example.com/video"
const secret = "https://user:secret-password@127.0.0.1/private?token=secret-token"
const captions: AttemptRecord = {
  loaderId: "youtube",
  status: "failed",
  elapsedSeconds: 0.5,
  diagnostic: { code: "captions_unavailable", phase: "captions" },
}
const duration = {
  loaderId: "youtube-ytdlp",
  status: "rejected",
  elapsedSeconds: 1,
  diagnostic: { code: "media_duration_limit", phase: "metadata", limit: 3_600, observed: 5_198 },
} satisfies AttemptRecord

describe("safe URL failure normalization", () => {
  it("preserves ordered factual failures, not raw error strings or later generic skips", () => {
    const error = new LoaderError(
      secret,
      [secret],
      [
        { ...captions, message: secret, errorCode: secret, errorType: secret },
        duration,
        {
          loaderId: "firecrawl",
          status: "skipped",
          elapsedSeconds: 0,
          diagnostic: { code: "configuration_missing" },
        },
      ],
    )
    const normalized = normalizeUrlFailure(error)
    expect(normalized).toMatchObject({
      code: "media_duration_limit",
      attempts: [captions, duration, { loaderId: "firecrawl" }],
    })
    expect(normalized.diagnostic).toEqual(duration.diagnostic)
    expect(JSON.stringify(normalized)).not.toContain("secret")
    expect(JSON.stringify(normalized)).not.toContain("errorCode")
    expect(error.message).toContain(secret)
  })

  it("handles aggregate errors in order, ignores duplicates and matches the requested URL", () => {
    const error = new AggregateError(
      [
        new LoaderError("https://example.com/other", [], [duration]),
        new LoaderError(url, [], [captions]),
      ],
      secret,
    )
    expect(normalizeUrlFailure(error, url)).toMatchObject({
      code: "captions_unavailable",
      attempts: [captions],
    })
    expect(normalizeUrlFailure(error, "https://example.com/missing")).toEqual({
      code: "unknown",
      attempts: [],
    })
    const shared = new LoaderError(url, [], [captions])
    expect(normalizeUrlFailure(new AggregateError([shared, shared]))).toMatchObject({
      attempts: [captions],
    })
  })

  it("keeps typed direct diagnostic facts and rejects message-based classification", () => {
    expect(normalizeUrlFailure(new TargetHttpError("HttpxLoader", secret, 403))).toMatchObject({
      code: "target_http_error",
      diagnostic: { code: "target_http_error", httpStatus: 403 },
      attempts: [],
    })
    expect(
      normalizeUrlFailure(new FailureDiagnosticError("YtdlpLoader", secret, duration.diagnostic)),
    ).toMatchObject({
      code: "media_duration_limit",
      diagnostic: duration.diagnostic,
    })
    expect(normalizeUrlFailure(new PublicUrlError("unsafe_url", secret))).toEqual({
      code: "unsafe_url",
      diagnostic: { code: "unsafe_url", phase: "validation" },
      attempts: [],
    })
    expect(
      normalizeUrlFailure(
        new Error("HTTP 403 captions disabled media duration exceeded whisper timeout"),
      ),
    ).toEqual({ code: "unknown", attempts: [] })
    expect(
      normalizeUrlFailure({
        code: "media_duration_limit",
        diagnostic: duration.diagnostic,
        message: secret,
      }),
    ).toEqual({ code: "unknown", attempts: [] })
  })

  it("does not classify successful or inapplicable attempts as failure evidence", () => {
    const error = new LoaderError(
      url,
      [],
      [
        { ...duration, status: "success" },
        { ...captions, status: "not_applicable" },
      ],
    )
    expect(normalizeUrlFailure(error)).toMatchObject({ code: "unknown" })
  })

  it("keeps service HTTP failures and local loader caps separate from target refusal and total deadlines", () => {
    expect(normalizeUrlFailure(new FirecrawlApiHttpError(secret, 403))).toMatchObject({
      code: "service_http_error",
      diagnostic: { code: "service_http_error", httpStatus: 403 },
    })
    expect(normalizeUrlFailure(new LoaderTimeoutError("HttpxLoader", secret, 12))).toMatchObject({
      code: "loader_timeout",
      diagnostic: { code: "loader_timeout", phase: "loading", limit: 12 },
    })
    expect(normalizeUrlFailure(new InvalidUrlError(secret, secret))).toMatchObject({
      code: "invalid_url",
      diagnostic: { code: "invalid_url", phase: "validation" },
    })
  })

  it.each([null, undefined, 1, secret, {}, { attempts: [captions] }])(
    "accepts malformed error input: %s",
    (error) => {
      expect(normalizeUrlFailure(error)).toEqual({ code: "unknown", attempts: [] })
    },
  )

  it("allowlists every string and rejects malformed, non-finite, negative and excessive numbers", () => {
    expect(
      sanitizeUrlAttempts([
        null,
        {},
        { status: secret, loaderId: "youtube" },
        {
          loaderId: secret,
          status: "failed",
          elapsedSeconds: Infinity,
          diagnostic: {
            code: secret,
            phase: secret,
            dependency: secret,
            limit: -1,
            observed: Infinity,
            httpStatus: 999,
            message: secret,
          },
        },
        {
          loaderId: "youtube",
          status: "timeout",
          elapsedSeconds: -1,
          diagnostic: {
            code: "download_timeout",
            phase: "download",
            limit: Number.MAX_VALUE,
            observed: NaN,
            httpStatus: 403.5,
          },
        },
        {
          loaderId: "ytdlp",
          status: "failed",
          elapsedSeconds: 0,
          diagnostic: {
            code: "dependency_missing",
            phase: "transcription",
            dependency: "whisper",
            limit: 0,
            observed: 0,
            httpStatus: 403,
          },
        },
      ]),
    ).toEqual([
      { loaderId: "unknown", status: "failed", diagnostic: { code: "unknown" } },
      {
        loaderId: "youtube",
        status: "timeout",
        diagnostic: { code: "download_timeout", phase: "download" },
      },
      {
        loaderId: "ytdlp",
        status: "failed",
        elapsedSeconds: 0,
        diagnostic: {
          code: "dependency_missing",
          phase: "transcription",
          dependency: "whisper",
          limit: 0,
          observed: 0,
          httpStatus: 403,
        },
      },
    ])
    expect(sanitizeUrlAttempts({ attempts: [captions] })).toEqual([])
    expect(
      sanitizeUrlAttempts([{ loaderId: "youtube", status: "failed", diagnostic: null }]),
    ).toEqual([{ loaderId: "youtube", status: "failed", diagnostic: { code: "unknown" } }])
  })

  it("copies only allowlisted finite stage timings on successes and failures", () => {
    const phaseTimingsMs = Object.defineProperty(
      {
        metadata: 1.4,
        download: 0,
        decode: 20,
        model_load: Infinity,
        inference: NaN,
        captions: 30,
        transcription: 40,
        loading: 50,
        [secret]: 60,
        transcript: secret,
        path: "/tmp/private-audio",
        stderr: secret,
      },
      "validation",
      {
        get() {
          throw new Error(secret)
        },
      },
    )
    const attempts = sanitizeUrlAttempts([
      { ...captions, status: "success", phaseTimingsMs },
      { ...duration, phaseTimingsMs: { metadata: -1, download: Number.MAX_VALUE, decode: secret } },
      { ...duration, phaseTimingsMs: { decode: 2, model_load: 3, inference: 4 } },
    ])
    expect(attempts[0]?.phaseTimingsMs).toEqual({ metadata: 1, download: 0, decode: 20 })
    expect(attempts[1]).not.toHaveProperty("phaseTimingsMs")
    expect(attempts[2]?.phaseTimingsMs).toEqual({ decode: 2, model_load: 3, inference: 4 })
    expect(JSON.stringify(attempts)).not.toMatch(/secret|private|transcript|stderr|Infinity|NaN/u)
    const inaccessible = Object.defineProperty({}, "decode", {
      get() {
        throw new Error(secret)
      },
    })
    expect(
      sanitizeUrlAttempts([{ ...captions, phaseTimingsMs: inaccessible }])[0],
    ).not.toHaveProperty("phaseTimingsMs")
  })

  it.each(["decode", "model_load", "inference"] as const)(
    "preserves %s without reclassifying total expiry as an ASR timeout",
    (phase) => {
      const normalized = normalizeUrlFailure(
        new LoaderError(
          url,
          [secret],
          [
            captions,
            {
              loaderId: "youtube-ytdlp",
              status: "timeout",
              elapsedSeconds: 180,
              diagnostic: { code: "deadline_exceeded", phase },
              phaseTimingsMs: { [phase]: 10 },
              message: secret,
            },
          ],
        ),
      )
      expect(normalized).toMatchObject({
        code: "deadline_exceeded",
        diagnostic: { code: "deadline_exceeded", phase },
        attempts: [captions, { diagnostic: { phase }, phaseTimingsMs: { [phase]: 10 } }],
      })
      expect(JSON.stringify(normalized)).not.toContain("secret")
      for (const [name, code] of [
        ["TimeoutError", "deadline_exceeded"],
        ["AbortError", "cancelled"],
      ] as const) {
        const recorded = new LoaderError(
          url,
          [secret],
          [
            captions,
            {
              loaderId: "youtube-ytdlp",
              status: name === "TimeoutError" ? "timeout" : "cancelled",
              elapsedSeconds: 10,
              diagnostic: { code, phase },
              phaseTimingsMs: { [phase]: 10 },
            },
          ],
        )
        const aggregate = new AggregateError(
          [new DOMException(secret, name), recorded, recorded],
          secret,
        )
        const interrupted = normalizeUrlFailure(aggregate, url)
        expect(interrupted.code).toBe(code)
        expect(interrupted.diagnostic).toEqual({ code, phase })
        expect(interrupted.attempts).toHaveLength(2)
        expect(normalizeUrlFailure(aggregate, "https://example.com/other").diagnostic?.phase).toBe(
          "loading",
        )
      }
    },
  )

  it.each(["@huggingface/transformers", "onnxruntime-node", "ffmpeg"] as const)(
    "retains structured missing dependency evidence for %s only",
    (dependency) => {
      const diagnostic = { code: "dependency_missing", phase: "model_load", dependency } as const
      expect(
        normalizeUrlFailure(new FailureDiagnosticError("YtdlpLoader", secret, diagnostic))
          .diagnostic,
      ).toEqual(diagnostic)
      expect(normalizeUrlFailure(new Error(`Cannot find ${dependency} ${secret}`)).code).toBe(
        "unknown",
      )
      const failure = normalizeUrlFailure(
        new FailureDiagnosticError("YtdlpLoader", secret, {
          code: "transcription_failed",
          phase: "model_load",
        }),
      )
      expect(failure.diagnostic).toEqual({ code: "transcription_failed", phase: "model_load" })
    },
  )

  it("retains allowlisted legacy code facts while new diagnostics remain authoritative", () => {
    const attempts = [
      "target_http_403",
      "firecrawl_api_http_429",
      "tls_certificate",
      "transport_failure",
      "target_http_999",
      secret,
    ].map((errorCode) => ({
      loaderId: "httpx",
      status: "failed",
      errorCode,
    }))
    expect(sanitizeUrlAttempts(attempts).map((attempt) => attempt.diagnostic)).toEqual([
      { code: "target_http_error", phase: "loading", httpStatus: 403 },
      { code: "service_http_error", phase: "loading", httpStatus: 429 },
      { code: "tls_certificate", phase: "loading" },
      { code: "transport_failure", phase: "loading" },
      undefined,
      undefined,
    ])
    expect(
      sanitizeUrlAttempts([
        { ...attempts[0], errorCode: "transport_failure", diagnostic: { code: "unknown" } },
      ])[0]?.diagnostic,
    ).toEqual({ code: "unknown" })
    expect(JSON.stringify(sanitizeUrlAttempts(attempts))).not.toContain("secret")
  })

  it("ignores metadata accessors and survives malformed typed diagnostics", () => {
    const diagnostic = Object.defineProperty({ code: "unknown" }, "phase", {
      get() {
        throw new Error(secret)
      },
    })
    expect(sanitizeUrlAttempts([{ ...captions, diagnostic }])[0]?.diagnostic).toEqual({
      code: "unknown",
    })
    const error = new FailureDiagnosticError("YtdlpLoader", url, { code: "unknown" })
    Object.defineProperty(error, "diagnostic", {
      get() {
        throw new Error(secret)
      },
    })
    expect(normalizeUrlFailure(error)).toEqual({ code: "unknown", attempts: [] })
  })

  it("bounds deep, cyclic and wide aggregates and large attempt arrays", () => {
    let deep: Error = new LoaderError(url, [], [duration])
    for (let i = 0; i < 10_000; i += 1) deep = new AggregateError([deep], secret)
    expect(normalizeUrlFailure(deep)).toEqual({ code: "unknown", attempts: [] })
    const cyclic = new AggregateError([], secret)
    cyclic.errors.push(cyclic, new LoaderError(url, [], [captions]))
    expect(normalizeUrlFailure(cyclic)).toMatchObject({
      code: "captions_unavailable",
      attempts: [captions],
    })
    expect(
      normalizeUrlFailure(
        new AggregateError(
          Array(10_000).fill(new LoaderError(url, [], Array(100).fill(duration))),
          secret,
        ),
      ).attempts,
    ).toHaveLength(32)
    expect(sanitizeUrlAttempts(Array(10_000).fill(captions))).toHaveLength(32)
  })

  it.each([undefined, "ECONNRESET", "CERT_HAS_EXPIRED"])(
    "uses URL-specific interruption evidence instead of classifying shared reason %s",
    async (code) => {
      const reason = Object.assign(new Error(secret), { code })
      for (const [target, loaderId] of [
        [url, "httpx"],
        ["https://example.com/other", "youtube"],
      ] as const) {
        const controller = new AbortController()
        const chain = resolveExplicitLoadChain(target, [loaderId], {
          getFactory: () => () => ({
            load: async () => {
              controller.abort(reason)
              throw reason
            },
          }),
        })
        await expect(chain.loadDetailed(controller.signal)).rejects.toBe(reason)
      }
      expect(normalizeUrlFailure(reason, url)).toMatchObject({
        code: "cancelled",
        attempts: [{ loaderId: "httpx", status: "cancelled" }],
      })
      expect(normalizeUrlFailure(reason, "https://example.com/other")).toMatchObject({
        code: "cancelled",
        attempts: [{ loaderId: "youtube", status: "cancelled" }],
      })
      const missing = normalizeUrlFailure(reason, "https://example.com/missing")
      expect(missing.attempts).toEqual([])
      expect(missing.code).toBe(
        code === "ECONNRESET"
          ? "transport_failure"
          : code === "CERT_HAS_EXPIRED"
            ? "tls_certificate"
            : "unknown",
      )
      expect(reason.message).toBe(secret)
    },
  )

  it("distinguishes whole-operation expiry from caller cancellation and per-phase timeouts", () => {
    expect(normalizeUrlFailure(new DOMException(secret, "TimeoutError"))).toMatchObject({
      code: "deadline_exceeded",
      attempts: [],
    })
    expect(normalizeUrlFailure(new DOMException(secret, "AbortError"))).toMatchObject({
      code: "cancelled",
      attempts: [],
    })
    expect(
      normalizeUrlFailure(
        new LoaderError(
          url,
          [],
          [
            captions,
            {
              loaderId: "youtube-ytdlp",
              status: "timeout",
              elapsedSeconds: 5,
              diagnostic: { code: "download_timeout", phase: "download" },
            },
          ],
        ),
      ),
    ).toMatchObject({
      code: "download_timeout",
      attempts: [captions, { diagnostic: { phase: "download" } }],
    })
  })
})
