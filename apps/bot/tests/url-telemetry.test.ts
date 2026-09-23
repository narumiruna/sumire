import { describe, expect, it, vi } from "vitest"

import type { Logger, SpanAttributes } from "../src/logging.js"

import {
  loadedUrlHost,
  singleUrlFingerprint,
  traceUrlLoad,
  urlFingerprint,
} from "../src/url-telemetry.js"

describe("URL telemetry", () => {
  it("correlates URL-only messages with exact tool arguments without logging URLs", () => {
    const url = "https://youtu.be/TuK6oX9BhtQ?token=secret#private"
    expect(singleUrlFingerprint(url)).toBe(urlFingerprint(url))
    expect(singleUrlFingerprint(`請看 ${url}`)).toBeUndefined()
    expect(singleUrlFingerprint(`https://user:pass@example.com/`)).toBeUndefined()
    expect(singleUrlFingerprint("https://example.com/a b")).toBeUndefined()
    expect(urlFingerprint(url)).toMatch(/^[a-f0-9]{64}$/u)
    expect(urlFingerprint(url)).not.toContain("secret")
  })

  it("records loader provenance but never full URLs or loaded content", async () => {
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
    const url = "https://example.com/private?token=secret"
    await traceUrlLoad(logger, url, undefined, "call-1", async () => ({
      url,
      finalUrl: "https://other.example.net/redirected?key=private",
      source: "url-content",
      loaderId: "youtube-transcript",
      contentType: "text/plain",
      text: "private document",
      truncated: true,
    }))
    expect(spans[0]).toMatchObject({
      "url.fingerprint": urlFingerprint(url),
      "url.requested_loader": "auto",
      "pi.tool_call_id": "call-1",
      "url.outcome": "success",
      "url.final_fingerprint": urlFingerprint("https://other.example.net/redirected?key=private"),
      "url.source": "url-content",
      "url.loader": "youtube-transcript",
      "url.truncated": true,
      "url.content_chars": 16,
      "url.host": "other.example.net",
    })
    expect(JSON.stringify(spans)).not.toContain("private document")
    expect(JSON.stringify(spans)).not.toContain("token=secret")
    expect(JSON.stringify(spans)).not.toContain("key=private")
    await expect(
      traceUrlLoad(logger, url, "built-in", "call-2", async () => {
        throw new TypeError("bad private URL")
      }),
    ).rejects.toThrow("bad private URL")
    expect(spans[1]).toMatchObject({
      "url.requested_loader": "built-in",
      "pi.tool_call_id": "call-2",
      "url.outcome": "error",
      "url.error_type": "TypeError",
    })
    expect(spans[1]).not.toHaveProperty("url.host")
  })

  it("exposes only the hostname of successfully loaded public URLs", () => {
    expect(loadedUrlHost("https://example.com/private?api_key=secret")).toBe("example.com")
    expect(loadedUrlHost("https://user:pass@example.com/")).toBeUndefined()
    expect(loadedUrlHost("file:///etc/passwd")).toBeUndefined()
  })
})
