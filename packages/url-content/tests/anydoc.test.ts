import { readFile } from "node:fs/promises"

import { afterEach, describe, expect, it, vi } from "vitest"
import { UrlContentClient } from "../src/client.js"
import * as conversion from "../src/core/anydoc.js"
import { LoaderTimeoutError } from "../src/core/errors.js"
import type { FetchImplementation } from "../src/core/network.js"
import type { ResourceProvider } from "../src/core/resources.js"
import { AnyDocLoader, MAX_ANYDOC_BYTES, MAX_ANYDOC_MARKDOWN_CHARS } from "../src/loaders/anydoc.js"
import { planForUrl } from "../src/pipelines/catalog.js"
import { ANYDOC_EXTENSIONS, isAnyDocUrl, parseAnyDocTarget } from "../src/sources/applicability.js"

const publicResolver = async () => [{ address: "8.8.8.8", family: 4 }]
const url = "https://example.com/report.docx"
const success = {
  ok: true as const,
  format: "docx",
  markdown: "document",
  originalChars: 8,
  truncated: false,
}
const fixture = (extension: string) =>
  readFile(
    new URL(`../../../apps/bot/tests/fixtures/documents/sample.${extension}`, import.meta.url),
  )

function loaderWithFetch(fetch: FetchImplementation, timeoutMs?: number) {
  return new AnyDocLoader({
    resources: { fetch } as ResourceProvider,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  })
}

afterEach(() => vi.restoreAllMocks())

describe("AnyDoc targets", () => {
  it.each(ANYDOC_EXTENSIONS)(
    "recognizes public .%s documents and preserves existing PDF plans",
    (extension) => {
      const target = `https://example.com/My%20Report.${extension.toUpperCase()}?download=1#page=1`
      expect(parseAnyDocTarget(target)).toEqual({
        url: target,
        filename: `My Report.${extension.toUpperCase()}`,
      })
      expect(planForUrl(target).executionPlan).toEqual(extension === "pdf" ? ["pdf"] : ["anydoc"])
      expect(planForUrl(target).fallbackLoaders).toEqual([])
    },
  )

  it.each([
    "file:///tmp/report.docx",
    "/tmp/report.docx",
    "ftp://example.com/report.docx",
    "https://user:pass@example.com/report.docx",
    "https://example.com/report.docx/",
    "https://example.com/download?filename=report.docx",
    "https://example.com/%ZZ.docx",
    "https://example.com/page.html",
  ])("rejects unsupported targets: %s", (target) => {
    expect(isAnyDocUrl(target)).toBe(false)
    expect(() => parseAnyDocTarget(target)).toThrow()
  })

  it("preserves Google Docs and GitHub source-specific plans", () => {
    expect(planForUrl("https://docs.google.com/document/d/test/edit").executionPlan).toEqual([
      "google-docs",
    ])
    expect(planForUrl("https://github.com/a/b/blob/main/file.pdf").executionPlan).toEqual([
      "github",
    ])
  })
})

describe("AnyDocLoader", () => {
  it.each(["docx", "xlsx", "pptx", "csv", "pdf"])(
    "converts real %s bytes in an isolated child",
    async (extension) => {
      const bytes = await fixture(extension)
      const fetch = vi.fn(
        async () =>
          new Response(bytes, { headers: { "content-type": "application/octet-stream" } }),
      )
      const markdown = await loaderWithFetch(fetch).load(`https://example.com/sample.${extension}`)
      expect(markdown.length).toBeGreaterThan(10)
      expect(fetch).toHaveBeenCalledOnce()
    },
  )

  it("uses content detection before a misleading filename extension", async () => {
    const bytes = await fixture("docx")
    const convert = vi.spyOn(conversion, "runAnyDocChild")
    const markdown = await loaderWithFetch(async () => new Response(bytes)).load(
      "https://example.com/file.csv",
    )
    expect(markdown.length).toBeGreaterThan(10)
    expect(await convert.mock.results[0]?.value).toMatchObject({ ok: true, format: "docx" })
  })

  it.each(["text/html", "application/json", "application/javascript", "image/png"])(
    "rejects %s responses before native conversion",
    async (contentType) => {
      const convert = vi.spyOn(conversion, "runAnyDocChild")
      const cancel = vi.fn()
      const response = new Response(new ReadableStream({ cancel }), {
        headers: { "content-type": contentType },
      })
      await expect(loaderWithFetch(async () => response).load(url)).rejects.toThrow(
        "Expected a document response",
      )
      expect(convert).not.toHaveBeenCalled()
      expect(cancel).toHaveBeenCalledOnce()
    },
  )

  it("rejects HTTP errors and empty documents without starting a converter", async () => {
    const convert = vi.spyOn(conversion, "runAnyDocChild")
    await expect(
      loaderWithFetch(async () => new Response(null, { status: 403 })).load(url),
    ).rejects.toThrow("HTTP 403")
    await expect(loaderWithFetch(async () => new Response(null)).load(url)).rejects.toThrow(
      "document is empty",
    )
    expect(convert).not.toHaveBeenCalled()
  })

  it.each([true, false])("bounds and cancels downloaded bodies (declared=%s)", async (declared) => {
    const convert = vi.spyOn(conversion, "runAnyDocChild")
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (!declared) controller.enqueue(new Uint8Array(MAX_ANYDOC_BYTES + 1))
      },
      cancel,
    })
    const response = new Response(body, {
      headers: declared ? { "content-length": String(MAX_ANYDOC_BYTES + 1) } : {},
    })
    await expect(loaderWithFetch(async () => response).load(url)).rejects.toThrow(
      `${MAX_ANYDOC_BYTES} byte limit`,
    )
    expect(convert).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each(["needsOcr", "encrypted", "unsupported", "malformed", "resourceLimit", "missingPart"])(
    "retains the native %s failure without generic fallback",
    async (code) => {
      vi.spyOn(conversion, "runAnyDocChild").mockResolvedValue({
        ok: false,
        code,
        message: "conversion detail",
      })
      await expect(loaderWithFetch(async () => new Response("bytes")).load(url)).rejects.toThrow(
        `AnyDoc conversion failed (${code}): conversion detail`,
      )
    },
  )

  it("rejects empty Markdown and marks bounded converter output as truncated", async () => {
    const convert = vi
      .spyOn(conversion, "runAnyDocChild")
      .mockResolvedValueOnce({ ...success, markdown: " " })
      .mockResolvedValueOnce({
        ...success,
        originalChars: MAX_ANYDOC_MARKDOWN_CHARS + 1,
        truncated: true,
      })
    const loader = loaderWithFetch(async () => new Response("bytes"))
    await expect(loader.load(url)).rejects.toThrow("produced no Markdown")
    await expect(loader.load(url)).resolves.toContain(
      `[truncated by anydoc: ${MAX_ANYDOC_MARKDOWN_CHARS + 1} -> ${MAX_ANYDOC_MARKDOWN_CHARS} chars]`,
    )
    expect(convert).toHaveBeenLastCalledWith(
      expect.any(Uint8Array),
      "report.docx",
      MAX_ANYDOC_MARKDOWN_CHARS,
      30_000,
      expect.any(AbortSignal),
    )
  })

  it("keeps a single timeout active across download and conversion", async () => {
    vi.spyOn(conversion, "runAnyDocChild").mockImplementation(
      async (_bytes, _name, _max, _timeout, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        }),
    )
    await expect(
      loaderWithFetch(async () => new Response("bytes"), 10).load(url),
    ).rejects.toBeInstanceOf(LoaderTimeoutError)
  })

  it("times out stalled downloads before starting native conversion", async () => {
    const convert = vi.spyOn(conversion, "runAnyDocChild")
    const fetch: FetchImplementation = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
      })
    await expect(loaderWithFetch(fetch, 5).load(url)).rejects.toBeInstanceOf(LoaderTimeoutError)
    expect(convert).not.toHaveBeenCalled()
  })

  it("propagates caller cancellation before fetching", async () => {
    const fetch = vi.fn()
    const reason = new Error("cancelled")
    await expect(loaderWithFetch(fetch).load(url, AbortSignal.abort(reason))).rejects.toBe(reason)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("AnyDoc client integration", () => {
  it("selects the registered worker loader and follows safe document redirects", async () => {
    const bytes = await fixture("docx")
    const fetchImplementation = vi.fn<FetchImplementation>(async (input) =>
      String(input) === url
        ? new Response(null, {
            status: 302,
            headers: { location: "https://cdn.example.com/report.docx" },
          })
        : new Response(bytes),
    )
    const client = new UrlContentClient({ resolve: publicResolver, fetchImplementation }).start()
    try {
      await expect(client.loadUrlDetailed(url)).resolves.toMatchObject({
        loaderId: "anydoc",
        contentType: "document_text",
        downgraded: false,
        attempts: [{ loaderId: "anydoc", status: "success" }],
      })
      expect(fetchImplementation).toHaveBeenCalledTimes(2)
    } finally {
      await client.close()
    }
  })

  it("validates redirect addresses before any conversion", async () => {
    const convert = vi.spyOn(conversion, "runAnyDocChild")
    const fetchImplementation = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "http://127.0.0.1/file.docx" } }),
    )
    const client = new UrlContentClient({ resolve: publicResolver, fetchImplementation }).start()
    try {
      await expect(client.loadUrl(url)).rejects.toThrow("Private")
      expect(fetchImplementation).toHaveBeenCalledOnce()
      expect(convert).not.toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })

  it("holds worker admission from download until isolated conversion settles", async () => {
    let release = (_result: conversion.AnyDocResult) => {}
    const pending = new Promise<conversion.AnyDocResult>((resolve) => {
      release = resolve
    })
    const convert = vi
      .spyOn(conversion, "runAnyDocChild")
      .mockReturnValueOnce(pending)
      .mockResolvedValue(success)
    const fetchImplementation = vi.fn(async () => new Response("bytes"))
    const client = new UrlContentClient({
      workerLimit: 1,
      resolve: publicResolver,
      fetchImplementation,
    }).start()
    const first = client.loadUrl(url)
    const second = client.loadUrl("https://example.com/second.docx")
    try {
      await vi.waitFor(() => expect(convert).toHaveBeenCalledOnce())
      expect(fetchImplementation).toHaveBeenCalledOnce()
    } finally {
      release(success)
      await Promise.all([first, second])
      await client.close()
    }
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
    expect(convert).toHaveBeenCalledTimes(2)
  })
})
