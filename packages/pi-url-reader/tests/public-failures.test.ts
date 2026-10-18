import type { lookup } from "node:dns/promises"

import { LoaderError, type LoadResult } from "@narumitw/sumire-url-reader"
import { describe, expect, it, vi } from "vitest"

import { createUrlTool, normalizeUrlFailure, PublicUrlError } from "../src/index.js"
import { assertPublicUrl, fetchPublicUrl, loadPublicUrl } from "../src/public-url.js"

const url = "https://8.8.8.8/article"
const secret = "https://user:password@127.0.0.1/private?token=secret"
const options = { allowedSchemes: new Set(["http", "https"]), maxChars: 100, timeoutMs: 1_000 }

describe("public URL failure boundaries", () => {
  it.each([
    ["not a URL", "invalid_url"],
    [secret, "unsafe_url"],
    ["file:///etc/passwd", "unsafe_url"],
    ["http://localhost/", "unsafe_url"],
    ["http://127.0.0.1/", "unsafe_url"],
  ])("classifies validation with a typed source error: %s", async (target, code) => {
    const error = await assertPublicUrl(target).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(PublicUrlError)
    expect(normalizeUrlFailure(error)).toMatchObject({
      code,
      diagnostic: { code, phase: "validation" },
    })
    expect(JSON.stringify(normalizeUrlFailure(error))).not.toContain("password")
  })

  it("classifies unsafe DNS results before invoking a loader", async () => {
    const error = await assertPublicUrl(
      "https://example.com/",
      options.allowedSchemes,
      (async () => [{ address: "10.0.0.1", family: 4 }]) as unknown as typeof lookup,
    ).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(PublicUrlError)
    expect(normalizeUrlFailure(error).code).toBe("unsafe_url")
  })

  it.each([
    [() => new Response(null, { status: 403 }), "target_http_error", { httpStatus: 403 }],
    [
      () => new Response("binary", { headers: { "content-type": "application/secret" } }),
      "unsupported_content_type",
      {},
    ],
    [() => new Response(null, { status: 302, headers: { location: url } }), "redirect_limit", {}],
    [() => new Response(null, { status: 302 }), "invalid_url", {}],
    [
      () =>
        new Response(null, {
          headers: { "content-type": "text/plain", "content-length": "64001" },
        }),
      "response_size_limit",
      { limit: 64_000, observed: 64_001 },
    ],
    [
      () => new Response("x".repeat(64_001), { headers: { "content-type": "text/plain" } }),
      "response_size_limit",
      { limit: 64_000, observed: 64_001 },
    ],
  ] as const)(
    "classifies built-in failures without parsing messages (%s)",
    async (response, code, details) => {
      const error = await fetchPublicUrl(url, {
        ...options,
        fetchImplementation: async () => response(),
      }).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(PublicUrlError)
      expect(normalizeUrlFailure(error)).toMatchObject({
        code,
        diagnostic: { code, phase: "loading", ...details },
      })
      expect(JSON.stringify(normalizeUrlFailure(error))).not.toContain("secret")
    },
  )

  it("distinguishes local validation and built-in caps from the shared deadline", async () => {
    const resolve = (() => new Promise<never>(() => {})) as unknown as typeof lookup
    const validation = await loadPublicUrl("https://pending.example/", {
      ...options,
      timeoutMs: 5,
      urlContentTimeoutSeconds: 1,
      resolve,
    }).catch((error: unknown) => error)
    expect(normalizeUrlFailure(validation)).toMatchObject({
      code: "loader_timeout",
      diagnostic: { code: "loader_timeout", phase: "validation", limit: 0.005 },
    })
    const builtIn = await fetchPublicUrl("https://pending.example/", {
      ...options,
      timeoutMs: 5,
      resolve,
    }).catch((error: unknown) => error)
    expect(normalizeUrlFailure(builtIn)).toMatchObject({
      code: "loader_timeout",
      diagnostic: { code: "loader_timeout", phase: "loading", limit: 0.005 },
    })
    const total = await loadPublicUrl("https://pending.example/", {
      ...options,
      urlContentTimeoutSeconds: 0.005,
      resolve,
    }).catch((error: unknown) => error)
    expect(normalizeUrlFailure(total)).toMatchObject({ code: "deadline_exceeded" })
  })

  it("returns complete safe failure details and does not pretend a failed load is content", async () => {
    const attempts = [
      {
        loaderId: "youtube",
        status: "failed" as const,
        elapsedSeconds: 1,
        diagnostic: { code: "captions_unavailable" as const, phase: "captions" as const },
        message: secret,
      },
    ]
    const tool = createUrlTool({
      load: async () => {
        throw new LoaderError(secret, [secret], attempts)
      },
    })
    const result = await tool.execute(
      "call",
      { url: secret },
      undefined,
      undefined,
      undefined as never,
    )
    expect(result).toMatchObject({
      isError: true,
      details: {
        code: "captions_unavailable",
        attempts: [{ diagnostic: { code: "captions_unavailable" } }],
      },
    })
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.details) }])
    expect(result.details).not.toHaveProperty("text")
    expect(JSON.stringify(result)).not.toContain("password")
    expect(JSON.stringify(result)).not.toContain("token")
  })

  it("does not duplicate retained non-interruption load-chain attempts", async () => {
    // LoaderError.attempts is authoritative even when the load chain also retains records.
    const error = new LoaderError(
      url,
      [],
      [
        {
          loaderId: "httpx",
          status: "failed",
          elapsedSeconds: 0,
          diagnostic: { code: "unknown", phase: "loading" },
        },
      ],
    )
    expect(normalizeUrlFailure(error, url)).toMatchObject({
      code: "unknown",
      attempts: [{ loaderId: "httpx" }],
    })
    expect(normalizeUrlFailure(error, url).attempts).toHaveLength(1)
  })

  it("preserves success payload fields and adds optional sanitized attempt diagnostics", async () => {
    const loaded: LoadResult = {
      content: "content",
      loaderId: "httpx",
      contentType: "generic_web",
      downgraded: false,
      attempts: [
        {
          loaderId: "youtube",
          status: "failed",
          elapsedSeconds: 0.5,
          errorType: "LoaderContentError",
          errorCode: "caption_extraction_failed",
          diagnostic: {
            code: "caption_extraction_failed",
            phase: "captions",
            message: secret,
          } as never,
        },
        { loaderId: "httpx", status: "success", elapsedSeconds: 1 },
      ],
    }
    const loader = {
      load: async () =>
        loadPublicUrl(url, {
          ...options,
          urlContentTimeoutSeconds: 5,
          urlContentLoadImplementation: async () => loaded,
        }),
    }
    const expected = await loader.load()
    const tool = createUrlTool(loader)
    const result = await tool.execute("call", { url }, undefined, undefined, undefined as never)
    expect(result.isError).toBeUndefined()
    expect(result.details).toEqual(expected)
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(expected) }])
    expect(expected.attempts?.[0]).toEqual({
      loaderId: "youtube",
      status: "failed",
      elapsedSeconds: 0.5,
      errorType: "LoaderContentError",
      errorCode: "caption_extraction_failed",
      diagnostic: { code: "caption_extraction_failed", phase: "captions" },
    })
    expect(expected.attempts?.[1]).not.toHaveProperty("diagnostic")
    expect(JSON.stringify(result)).not.toContain("password")
  })

  it.each([new Error(secret), { reason: secret }, secret])(
    "preserves the original cancellation reason: %s",
    async (reason) => {
      const controller = new AbortController()
      const load = vi.fn(async () => {
        controller.abort(reason)
        throw new Error("different backend failure")
      })
      const tool = createUrlTool({ load })
      await expect(
        tool.execute("call", { url }, controller.signal, undefined, undefined as never),
      ).rejects.toBe(reason)
      expect(load).toHaveBeenCalledOnce()
      await expect(
        tool.execute("call", { url }, controller.signal, undefined, undefined as never),
      ).rejects.toBe(reason)
      expect(load).toHaveBeenCalledOnce()
    },
  )
})
