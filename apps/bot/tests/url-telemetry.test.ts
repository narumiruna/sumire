import { normalizeUrlFailure, sanitizeUrlAttempts } from "@narumitw/sumire-pi-url-reader"
import { LoaderError, resolveExplicitLoadChain } from "@narumitw/sumire-url-reader"
import { describe, expect, it, vi } from "vitest"
import type { Logger, SpanAttributes } from "../src/logging.js"
import {
  loadedUrlHost,
  singleUrlFingerprint,
  traceUrlLoad,
  urlFingerprint,
} from "../src/url-telemetry.js"

function recordingLogger() {
  const spans: SpanAttributes[] = []
  const logger: Logger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    span: async (_name, attributes, callback) => {
      const record = { ...attributes }
      spans.push(record)
      return callback({
        setAttribute: (key, value) => {
          record[key] = value
        },
      })
    },
  }
  return { logger, spans }
}

describe("URL telemetry", () => {
  it("correlates URL-only messages with exact tool arguments without logging URLs", () => {
    const url = "https://youtu.be/TuK6oX9BhtQ?token=secret#private"
    expect(singleUrlFingerprint(url)).toBe(urlFingerprint(url))
    expect(singleUrlFingerprint(`請看 ${url}`)).toBeUndefined()
    expect(singleUrlFingerprint("https://user:pass@example.com/")).toBeUndefined()
    expect(singleUrlFingerprint("https://example.com/a b")).toBeUndefined()
    expect(urlFingerprint(url)).toMatch(/^[a-f0-9]{64}$/u)
    expect(urlFingerprint(url)).not.toContain("secret")
  })

  it("records safe provenance and the same diagnostics as the tool boundary", async () => {
    const { logger, spans } = recordingLogger()
    const url = "https://example.com/private?token=secret"
    const attempts = [
      {
        loaderId: "youtube",
        status: "failed" as const,
        elapsedSeconds: 1,
        diagnostic: { code: "captions_unavailable" as const, phase: "captions" as const },
      },
      { loaderId: "youtube-ytdlp", status: "success" as const, elapsedSeconds: 2 },
    ]
    await traceUrlLoad(logger, url, undefined, "call-1", async () => ({
      url,
      finalUrl: "https://other.example.net/redirected?key=private",
      source: "url-content",
      loaderId: "youtube-ytdlp",
      contentType: "text/plain",
      text: "private document",
      truncated: true,
      attempts,
    }))
    expect(spans[0]).toMatchObject({
      "url.fingerprint": urlFingerprint(url),
      "url.requested_loader": "auto",
      "pi.tool_call_id": "call-1",
      "url.outcome": "success",
      "url.source": "url-content",
      "url.loader": "youtube-ytdlp",
      "url.truncated": true,
      "url.content_chars": 16,
      "url.host": "other.example.net",
      "url.final_fingerprint": urlFingerprint("https://other.example.net/redirected?key=private"),
      "url.attempts": JSON.stringify(sanitizeUrlAttempts(attempts)),
    })
    expect(JSON.stringify(spans)).not.toMatch(/private document|token=secret|key=private/u)

    const failure = new LoaderError(
      url,
      ["sensitive details"],
      [
        ...attempts.slice(0, 1),
        {
          loaderId: "youtube-ytdlp",
          status: "failed",
          elapsedSeconds: 2,
          diagnostic: {
            code: "media_duration_limit",
            phase: "metadata",
            observed: 5_198,
            limit: 3_600,
          },
        },
        {
          loaderId: "invalid-private-id",
          status: "failed",
          elapsedSeconds: 0,
          errorType: "private text",
          errorCode: "sensitive details",
          message: "secret",
        },
      ],
    )
    await expect(
      traceUrlLoad(logger, url, undefined, "call-2", async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
    const normalized = normalizeUrlFailure(failure, url)
    expect(spans[1]).toMatchObject({
      "url.outcome": "error",
      "url.error_code": normalized.code,
      "url.attempts": JSON.stringify(normalized.attempts),
    })
    expect(JSON.stringify(spans)).toContain("media_duration_limit")
    expect(JSON.stringify(spans)).toContain("5198")
    expect(JSON.stringify(spans)).not.toMatch(
      /sensitive details|private text|invalid-private-id|secret/u,
    )
  })

  it("logs unknown errors safely and does not invoke the URL load twice", async () => {
    const { logger, spans } = recordingLogger()
    const failure = new TypeError("https://user:password@example.com/?token=secret")
    const load = vi.fn(async () => {
      throw failure
    })
    await expect(
      traceUrlLoad(logger, "https://example.com", "built-in", "call", load),
    ).rejects.toBe(failure)
    expect(load).toHaveBeenCalledOnce()
    expect(spans[0]).toMatchObject({ "url.error_code": "unknown", "url.outcome": "error" })
    expect(spans[0]).not.toHaveProperty("url.host")
    expect(JSON.stringify(spans)).not.toMatch(/password|secret/u)
  })

  it.each(["AbortError", "TimeoutError"])(
    "retains safe attempts for %s without logging the reason",
    async (name) => {
      const { logger, spans } = recordingLogger()
      const controller = new AbortController()
      const entered = vi.fn()
      const url = "https://example.com/private?key=secret"
      const chain = resolveExplicitLoadChain(url, ["httpx"], {
        getFactory: () => () => ({
          load: async () => {
            entered()
            return new Promise<string>(() => {})
          },
        }),
      })
      const reason = new DOMException("private raw error", name)
      const loading = traceUrlLoad(logger, url, undefined, "call", async () => {
        await chain.loadDetailed(controller.signal)
        throw new Error("unreachable")
      }).catch((error) => error)
      await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
      controller.abort(reason)
      expect(await loading).toBe(reason)
      expect(spans[0]?.["url.error_code"]).toBe(
        name === "AbortError" ? "cancelled" : "deadline_exceeded",
      )
      expect(JSON.parse(String(spans[0]?.["url.attempts"]))[0]).toMatchObject({
        loaderId: "httpx",
        status: name === "AbortError" ? "cancelled" : "timeout",
        elapsedSeconds: expect.any(Number),
      })
      expect(JSON.stringify(spans)).not.toMatch(/private|secret|raw error/u)
    },
  )

  it("exposes only the hostname of successfully loaded public URLs", () => {
    expect(loadedUrlHost("https://example.com/private?api_key=secret")).toBe("example.com")
    expect(loadedUrlHost("https://user:pass@example.com/")).toBeUndefined()
    expect(loadedUrlHost("file:///etc/passwd")).toBeUndefined()
  })
})
