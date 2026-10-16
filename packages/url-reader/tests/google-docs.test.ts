import { describe, expect, it, vi } from "vitest"

import { UrlContentClient } from "../src/client.js"
import {
  LoaderContentError,
  LoaderNotApplicableError,
  LoaderTimeoutError,
} from "../src/core/errors.js"
import type { FetchImplementation } from "../src/core/network.js"
import type { ResourceProvider } from "../src/core/resources.js"
import { GoogleDocsLoader, MAX_GOOGLE_DOCS_BYTES } from "../src/loaders/google-docs.js"
import { planForUrl } from "../src/pipelines/catalog.js"
import { isGoogleDocsUrl, parseGoogleDocsTarget } from "../src/sources/applicability.js"

const baseUrl = "https://docs.google.com/document/d/test-doc_123"
const exportUrl = `${baseUrl}/export?format=txt`
const publicResolver = async () => [{ address: "8.8.8.8", family: 4 }]
const textResponse = (text: string) =>
  new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } })

function loaderWithFetch(fetch: FetchImplementation, timeoutMs?: number) {
  return new GoogleDocsLoader({
    resources: { fetch } as ResourceProvider,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
}

describe("Google Docs targets", () => {
  it.each([
    baseUrl,
    `${baseUrl}/`,
    `${baseUrl}/edit?usp=sharing`,
    `${baseUrl}/view`,
    `${baseUrl}/preview/`,
    `${baseUrl}/export?format=pdf`,
    "https://docs.google.com/document/u/0/d/test-doc_123/edit",
    "http://docs.google.com/document/d/test-doc_123/edit",
  ])("normalizes %s to the HTTPS text export", (url) => {
    expect(isGoogleDocsUrl(url)).toBe(true)
    expect(parseGoogleDocsTarget(url)).toEqual({ url, documentId: "test-doc_123", exportUrl })
  })

  it("preserves the selected tab and resource key but drops editor-only parameters", () => {
    expect(
      parseGoogleDocsTarget(
        `${baseUrl}/edit?tab=t.abc_123&resourcekey=0-test-key&usp=sharing&authuser=1#heading=h.test`,
      ).exportUrl,
    ).toBe(`${exportUrl}&tab=t.abc_123&resourcekey=0-test-key`)
  })

  it.each([
    "not a URL",
    "ftp://docs.google.com/document/d/test-doc_123/edit",
    "https://docs.google.com.evil.example/document/d/test-doc_123/edit",
    "https://docs.google.com@evil.example/document/d/test-doc_123/edit",
    "https://user:password@docs.google.com/document/d/test-doc_123/edit",
    "https://docs.google.com:8443/document/d/test-doc_123/edit",
    "https://docs.google.com/document/d/",
    "https://docs.google.com/document/d/test%2Fdoc/edit",
    "https://docs.google.com/document/d/test-doc_123/edit/extra",
    "https://docs.google.com/document/d/e/published-id/pub",
    "https://docs.google.com/spreadsheets/d/test-doc_123/edit",
    "https://docs.google.com/presentation/d/test-doc_123/edit",
  ])("rejects unsupported or misleading targets: %s", (url) => {
    expect(isGoogleDocsUrl(url)).toBe(false)
    expect(() => parseGoogleDocsTarget(url)).toThrow()
  })

  it("uses only the dedicated loader with a source-required contract", () => {
    expect(planForUrl(`${baseUrl}/edit?tab=t.0`)).toEqual({
      pipelineName: "google-docs",
      contentType: "document_text",
      targetedLoaders: ["google-docs"],
      fallbackLoaders: [],
      executionPlan: ["google-docs"],
      contentContract: "source_required",
    })
  })
})

describe("GoogleDocsLoader", () => {
  it("fetches only the export and preserves Unicode, whitespace, and literal markup", async () => {
    const text = "標題\n\n  縮排與 <literal> & characters\n\t第二段 🌸\n"
    const fetch = vi.fn(async () => textResponse(text))
    await expect(loaderWithFetch(fetch).load(`${baseUrl}/edit?tab=t.0`)).resolves.toBe(text)
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`${exportUrl}&tab=t.0`, {
      headers: { Accept: "text/plain" },
      redirect: "follow",
      signal: expect.any(AbortSignal),
    })
  })

  it("rejects unsupported targets without fetching", async () => {
    const fetch = vi.fn()
    await expect(loaderWithFetch(fetch).load("https://example.com")).rejects.toBeInstanceOf(
      LoaderNotApplicableError,
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([401, 403, 404, 429, 500])(
    "reports HTTP %s and cancels the response body",
    async (status) => {
      const cancel = vi.fn()
      const fetch = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status }))
      await expect(loaderWithFetch(fetch).load(baseUrl)).rejects.toMatchObject({
        name: "LoaderContentError",
        reason: `Google Docs export returned HTTP ${status}`,
        suggestion: expect.stringContaining("without signing in"),
      })
      expect(cancel).toHaveBeenCalledOnce()
    },
  )

  it.each(["text/html", "application/xhtml+xml", "application/pdf", undefined])(
    "rejects editor/login pages and non-text exports (%s)",
    async (contentType) => {
      const cancel = vi.fn()
      const fetch = vi.fn(
        async () =>
          new Response(new ReadableStream({ cancel }), {
            headers: contentType ? { "content-type": contentType } : {},
          }),
      )
      await expect(loaderWithFetch(fetch).load(baseUrl)).rejects.toThrow(
        "Expected a plain-text export",
      )
      expect(cancel).toHaveBeenCalledOnce()
    },
  )

  it("rejects empty exports", async () => {
    await expect(
      loaderWithFetch(async () => textResponse(" \n\t")).load(baseUrl),
    ).rejects.toBeInstanceOf(LoaderContentError)
  })

  it("enforces declared and streamed byte limits and cancels oversized bodies", async () => {
    for (const declared of [true, false]) {
      const cancel = vi.fn()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (!declared) controller.enqueue(new Uint8Array(MAX_GOOGLE_DOCS_BYTES + 1))
        },
        cancel,
      })
      const response = new Response(body, {
        headers: {
          "content-type": "text/plain",
          ...(declared ? { "content-length": String(MAX_GOOGLE_DOCS_BYTES + 1) } : {}),
        },
      })
      await expect(loaderWithFetch(async () => response).load(baseUrl)).rejects.toThrow(
        `${MAX_GOOGLE_DOCS_BYTES} byte limit`,
      )
      expect(cancel).toHaveBeenCalledOnce()
    }
  })

  it("times out stalled requests", async () => {
    const fetch: FetchImplementation = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })
    await expect(loaderWithFetch(fetch, 5).load(baseUrl)).rejects.toBeInstanceOf(LoaderTimeoutError)
  })

  it("keeps the timeout active while reading the export body", async () => {
    const fetch: FetchImplementation = async (_input, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial document"))
            init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), {
              once: true,
            })
          },
        }),
        { headers: { "content-type": "text/plain" } },
      )
    await expect(loaderWithFetch(fetch, 5).load(baseUrl)).rejects.toBeInstanceOf(LoaderTimeoutError)
  })

  it.each([false, true])(
    "preserves caller cancellation (alreadyAborted=%s)",
    async (alreadyAborted) => {
      const controller = new AbortController()
      const reason = new Error("cancelled by caller")
      const fetch = vi.fn<FetchImplementation>(
        async (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            })
          }),
      )
      if (alreadyAborted) controller.abort(reason)
      const loading = loaderWithFetch(fetch).load(baseUrl, controller.signal)
      controller.abort(reason)
      await expect(loading).rejects.toBe(reason)
      expect(fetch).toHaveBeenCalledTimes(alreadyAborted ? 0 : 1)
    },
  )
})

describe("Google Docs client integration", () => {
  it("uses the registered loader and follows public export redirects without browser fallbacks", async () => {
    const downloadUrl = "https://doc-00-docstext.googleusercontent.com/export/test"
    const fetchImplementation = vi.fn<FetchImplementation>(async (input) => {
      if (String(input) === exportUrl) {
        return new Response(null, { status: 302, headers: { location: downloadUrl } })
      }
      expect(String(input)).toBe(downloadUrl)
      return textResponse("Document body")
    })
    const client = new UrlContentClient({ fetchImplementation, resolve: publicResolver }).start()
    const browser = vi.spyOn(client, "browser")
    const impers = vi.spyOn(client, "impersSession")
    try {
      const result = await client.loadUrlDetailed(`${baseUrl}/edit`)
      expect(result).toMatchObject({
        content: "Document body",
        contentType: "document_text",
        loaderId: "google-docs",
        downgraded: false,
        attempts: [{ loaderId: "google-docs", status: "success" }],
      })
      expect(fetchImplementation).toHaveBeenCalledTimes(2)
      expect(browser).not.toHaveBeenCalled()
      expect(impers).not.toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })

  it.each(["http://127.0.0.1/private", "http://[::1]/private", "http://private.example/"])(
    "rejects unsafe export redirects to %s without trying generic loaders",
    async (location) => {
      const fetchImplementation = vi.fn(
        async () => new Response(null, { status: 302, headers: { location } }),
      )
      const client = new UrlContentClient({
        fetchImplementation,
        resolve: async (host) =>
          host === "private.example" ? [{ address: "10.0.0.1", family: 4 }] : publicResolver(),
      }).start()
      try {
        await expect(client.loadUrlDetailed(baseUrl)).rejects.toThrow(/[Pp]rivate/)
        expect(fetchImplementation).toHaveBeenCalledOnce()
      } finally {
        await client.close()
      }
    },
  )

  it("retains access-denied details without falling back to generic HTML", async () => {
    const fetchImplementation = vi.fn(async () => new Response(null, { status: 403 }))
    const client = new UrlContentClient({ fetchImplementation, resolve: publicResolver }).start()
    try {
      await expect(client.loadUrlDetailed(baseUrl)).rejects.toMatchObject({
        details: [expect.stringContaining("Google Docs export returned HTTP 403")],
        attempts: [{ loaderId: "google-docs", status: "failed" }],
      })
      expect(fetchImplementation).toHaveBeenCalledOnce()
    } finally {
      await client.close()
    }
  })
})
