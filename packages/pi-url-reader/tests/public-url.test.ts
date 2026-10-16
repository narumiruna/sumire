import type { lookup } from "node:dns/promises"

import { LoaderContentError, resolveLoadChain, UrlContentClient } from "@narumitw/sumire-url-reader"
import { htmlToMarkdown } from "@narumitw/sumire-url-reader/loaders"
import { describe, expect, it, vi } from "vitest"
import {
  assertPublicUrl,
  createPinnedLookup,
  fetchPublicUrl,
  isPublicIp,
  type LoadedUrl,
  loadPublicUrl,
} from "../src/public-url.js"
import { createUrlTool } from "../src/url-tool.js"

const options = {
  allowedSchemes: new Set(["http", "https"]),
  maxChars: 100,
  timeoutMs: 1_000,
}

describe("public URL loading", () => {
  it.each([
    "https://example.com",
    "https://en.wikipedia.org/wiki/Function_(mathematics)",
    "https://example.com/items[1]",
    "https://example.com/items{1}",
  ])("loads the exact URL only on agent execution and forwards cancellation: %s", async (url) => {
    const load = vi.fn(async () => ({
      url,
      finalUrl: url,
      source: "built-in" as const,
      contentType: "text/plain",
      text: "content",
      truncated: false,
    }))
    const tool = createUrlTool({ load })
    expect(load).not.toHaveBeenCalled()
    const signal = new AbortController().signal
    const result = await tool.execute("call", { url }, signal, undefined, undefined as never)
    expect(load).toHaveBeenCalledWith(url, { signal })
    expect(result).toMatchObject({ details: { text: "content" } })
  })

  it("traces the requested URL and selected result without changing loading or error behavior", async () => {
    const url = "https://example.com/article?key=private"
    const loaded = {
      url,
      finalUrl: url,
      source: "built-in" as const,
      contentType: "text/plain",
      text: "article",
      truncated: false,
    }
    const load = vi.fn(async () => loaded)
    const traceLoad = vi.fn(
      async (
        _url: string,
        _loader: string | undefined,
        _toolCallId: string,
        run: () => Promise<LoadedUrl>,
      ) => run(),
    )
    const tool = createUrlTool({ load }, { traceLoad })

    await expect(
      tool.execute("call", { url, loader: "built-in" }, undefined, undefined, undefined as never),
    ).rejects.toThrow("URL loader is not selectable")
    expect(traceLoad).not.toHaveBeenCalled()

    const result = await tool.execute("call", { url }, undefined, undefined, undefined as never)
    expect(traceLoad).toHaveBeenCalledWith(url, undefined, "call", expect.any(Function))
    expect(load).toHaveBeenCalledExactlyOnceWith(url, {})
    expect(result.details).toEqual(loaded)

    load.mockRejectedValueOnce(new Error("load failed"))
    await expect(
      tool.execute("call", { url }, undefined, undefined, undefined as never),
    ).rejects.toThrow("load failed")
    expect(traceLoad).toHaveBeenCalledTimes(2)
  })

  it("classifies private, local, and public IP addresses", () => {
    expect(isPublicIp("127.0.0.1")).toBe(false)
    expect(isPublicIp("10.0.0.1")).toBe(false)
    expect(isPublicIp("169.254.169.254")).toBe(false)
    expect(isPublicIp("::1")).toBe(false)
    expect(isPublicIp("fd00::1")).toBe(false)
    expect(isPublicIp("fec0::1")).toBe(false)
    expect(isPublicIp("feff::1")).toBe(false)
    expect(isPublicIp("2001:db8::1")).toBe(false)
    expect(isPublicIp("::ffff:127.0.0.1")).toBe(false)
    expect(isPublicIp("8.8.8.8")).toBe(true)
    expect(isPublicIp("2606:4700:4700::1111")).toBe(true)
  })

  it("rejects unsafe schemes, credentials, and local targets while accepting public IPv6 literals", async () => {
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow("scheme")
    await expect(assertPublicUrl("https://user:pass@8.8.8.8/")).rejects.toThrow("credentials")
    await expect(assertPublicUrl("http://127.0.0.1/")).rejects.toThrow("Private")
    await expect(assertPublicUrl("http://[::1]/")).rejects.toThrow("Private")
    await expect(assertPublicUrl("http://localhost/")).rejects.toThrow("Local")
    await expect(assertPublicUrl("https://[2606:4700:4700::1111]/")).resolves.toMatchObject({
      hostname: "[2606:4700:4700::1111]",
    })
  })

  it("applies the operation timeout while DNS resolution is pending", async () => {
    const resolve = vi.fn(() => new Promise<never>(() => {})) as unknown as typeof lookup
    const fetchImplementation = vi.fn(async () => new Response())

    await expect(
      fetchPublicUrl("https://pending.example/", {
        ...options,
        timeoutMs: 10,
        fetchImplementation,
        resolve,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" })
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it("pins requests to the addresses that passed public-IP validation", async () => {
    const pinnedLookup = createPinnedLookup([{ address: "8.8.8.8", family: 4 }])
    const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      pinnedLookup("rebinding.example", { all: false }, (error, address, family) => {
        if (error) {
          reject(error)
          return
        }
        if (typeof address !== "string") {
          reject(new Error("Expected one pinned address"))
          return
        }
        resolve({ address, family: family ?? 0 })
      })
    })

    expect(result).toEqual({ address: "8.8.8.8", family: 4 })
  })

  it("extracts bounded text and checks every redirect target", async () => {
    const htmlFetch = vi.fn(async () => {
      return new Response(
        "<html><title>Example &amp; Test</title><body><h1>Hello</h1><script>bad()</script>world</body></html>",
        {
          headers: { "content-type": "text/html; charset=utf-8" },
          status: 200,
        },
      )
    })
    await expect(
      fetchPublicUrl("https://8.8.8.8/page", { ...options, fetchImplementation: htmlFetch }),
    ).resolves.toMatchObject({
      finalUrl: "https://8.8.8.8/page",
      title: "Example & Test",
      text: "Example & Test Hello\n world",
      truncated: false,
    })

    const redirectFetch = vi.fn(async () => {
      return new Response(null, { headers: { location: "http://127.0.0.1/private" }, status: 302 })
    })
    await expect(
      fetchPublicUrl("https://8.8.8.8/redirect", {
        ...options,
        fetchImplementation: redirectFetch,
      }),
    ).rejects.toThrow("Private")
  })

  it.each([
    "https://8.8.8.8/article",
    "http://8.8.8.8/plain.txt",
    "https://example.com/short-page",
    "https://wallhop.io/https://www.wsj.com/world/article?mod=hp_lead_pos1",
    "https://notwallhop.io/article",
  ])("delegates automatic loading to url-content without a built-in request: %s", async (url) => {
    const fetchImplementation = vi.fn(
      async () =>
        new Response(
          "<html><title>wsj.com</title><body>Please enable JS and disable any ad blocker</body></html>",
          { headers: { "content-type": "text/html" } },
        ),
    )
    const source = vi.fn(async (_url: string, _options: { loaderNames?: readonly string[] }) => ({
      content: "Readable article body",
      loaderId: "curl-cffi",
      contentType: "generic_web",
      downgraded: false,
      attempts: [{ loaderId: "curl-cffi", status: "success" as const, elapsedSeconds: 1 }],
    }))
    const signal = new AbortController().signal
    await expect(
      loadPublicUrl(url, {
        ...options,
        signal,
        resolve: (async () => [{ address: "8.8.8.8", family: 4 }]) as unknown as typeof lookup,
        fetchImplementation,
        urlContentTimeoutSeconds: 12,
        urlContentLoadImplementation: source,
      }),
    ).resolves.toMatchObject({
      url,
      finalUrl: url,
      source: "url-content",
      loaderId: "curl-cffi",
      text: "Readable article body",
      attempts: [{ loaderId: "curl-cffi", status: "success", elapsedSeconds: 1 }],
    })
    expect(fetchImplementation).not.toHaveBeenCalled()
    expect(source).toHaveBeenCalledExactlyOnceWith(url, {
      allowedSchemes: options.allowedSchemes,
      deadlineSeconds: expect.any(Number),
      signal: expect.any(AbortSignal),
    })
    expect(source.mock.calls[0]?.[1]).not.toHaveProperty("loaderNames")
  })

  it.each([undefined, "httpx"])(
    "preserves HTTPS-only policy across delegated redirects (loader=%s)",
    async (loader) => {
      const transport = vi.fn(async (input: string | URL) =>
        new URL(input).protocol === "https:"
          ? new Response(null, { status: 302, headers: { location: "http://8.8.8.8/final" } })
          : new Response("downgraded content", { headers: { "content-type": "text/plain" } }),
      )
      const fetchImplementation = vi.fn()
      const allowedSchemes = new Set(["https"])
      await expect(
        loadPublicUrl("https://8.8.8.8/start", {
          ...options,
          allowedSchemes,
          loader,
          fetchImplementation,
          urlContentTimeoutSeconds: 12,
          urlContentLoadImplementation: async (url, sourceOptions) => {
            expect(sourceOptions.allowedSchemes).toEqual(allowedSchemes)
            await using client = new UrlContentClient({
              allowedSchemes: sourceOptions.allowedSchemes,
              deadlineSeconds: sourceOptions.deadlineSeconds,
              fetchImplementation: transport,
            }).start()
            return await client.loadUrlDetailed(url, {
              loaderNames: sourceOptions.loaderNames ?? ["httpx"],
              signal: sourceOptions.signal,
            })
          },
        }),
      ).rejects.toThrow("Failed to load URL")
      expect(transport).toHaveBeenCalledTimes(1)
      expect(fetchImplementation).not.toHaveBeenCalled()
    },
  )

  it("preserves source-aware plain text without HTML conversion", async () => {
    const fetchImplementation = vi.fn()
    await expect(
      loadPublicUrl("https://8.8.8.8/plain.txt", {
        ...options,
        fetchImplementation,
        urlContentTimeoutSeconds: 12,
        urlContentLoadImplementation: async () => ({
          content: "Use <tag> & keep\nline breaks.",
          loaderId: "httpx",
          contentType: "generic_web",
          downgraded: false,
          attempts: [],
        }),
      }),
    ).resolves.toMatchObject({
      source: "url-content",
      text: "Use <tag> & keep\nline breaks.",
      truncated: false,
    })
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it("automatically reaches a fast browser on the first tool call after source transport failure", async () => {
    const url = "https://8.8.8.8/article"
    const built: string[] = []
    const fetchImplementation = vi.fn()
    const tool = createUrlTool({
      load: (target, request) =>
        loadPublicUrl(target, {
          ...options,
          maxChars: 1_000,
          urlContentTimeoutSeconds: 2,
          signal: request?.signal,
          fetchImplementation,
          urlContentLoadImplementation: async (_target, sourceOptions) =>
            resolveLoadChain(target, {
              getFactory: (name) => () => {
                built.push(name)
                return {
                  load: async () => {
                    if (name === "curl-cffi")
                      throw new LoaderContentError("CurlCffiLoader", target, "transport failed")
                    if (name === "playwright-fast") return "Readable article body"
                    throw new Error("must not construct slower alternatives")
                  },
                }
              },
            }).loadDetailed(sourceOptions.signal),
        }),
    })
    const result = await tool.execute("call", { url }, undefined, undefined, undefined as never)
    expect(result.details).toMatchObject({
      source: "url-content",
      loaderId: "playwright-fast",
      text: "Readable article body",
      attempts: [
        { loaderId: "curl-cffi", status: "failed" },
        { loaderId: "playwright-fast", status: "success" },
      ],
    })
    expect(built).toEqual(["curl-cffi", "playwright-fast"])
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it("includes validation time in the source deadline and forwards Firecrawl opt-in", async () => {
    const source = vi.fn(async () => ({
      content: "article",
      loaderId: "httpx",
      contentType: "generic_web",
      downgraded: false,
      attempts: [],
    }))
    await loadPublicUrl("https://example.com/article", {
      ...options,
      urlContentTimeoutSeconds: 1,
      firecrawlFallback: true,
      resolve: (async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return [{ address: "8.8.8.8", family: 4 }]
      }) as unknown as typeof lookup,
      urlContentLoadImplementation: source,
    })
    expect(source).toHaveBeenCalledWith(
      "https://example.com/article",
      expect.objectContaining({
        deadlineSeconds: expect.any(Number),
        firecrawlFallback: true,
        signal: expect.any(AbortSignal),
      }),
    )
    const budget = (source.mock.calls[0] as unknown as [string, { deadlineSeconds: number }])[1]
      .deadlineSeconds
    expect(budget).toBeGreaterThan(0)
    expect(budget).toBeLessThan(0.99)
  })

  it("does not start source loading when the total deadline expires during validation", async () => {
    const source = vi.fn()
    await expect(
      loadPublicUrl("https://pending.example/article", {
        ...options,
        urlContentTimeoutSeconds: 0.01,
        resolve: (() => new Promise<never>(() => {})) as unknown as typeof lookup,
        urlContentLoadImplementation: source,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" })
    expect(source).not.toHaveBeenCalled()
  })

  it("forwards caller cancellation to source loading and preserves its reason", async () => {
    const controller = new AbortController()
    const reason = new Error("Caller cancelled")
    const fetchImplementation = vi.fn()
    await expect(
      loadPublicUrl("https://8.8.8.8/article", {
        ...options,
        signal: controller.signal,
        fetchImplementation,
        urlContentTimeoutSeconds: 12,
        urlContentLoadImplementation: async (_url, sourceOptions) => {
          controller.abort(reason)
          sourceOptions.signal?.throwIfAborted()
          throw new Error("Expected the forwarded signal to be aborted")
        },
      }),
    ).rejects.toBe(reason)
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it("rejects a late successful source result after the total deadline", async () => {
    await expect(
      loadPublicUrl("https://8.8.8.8/article", {
        ...options,
        urlContentTimeoutSeconds: 0.01,
        urlContentLoadImplementation: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20))
          return {
            content: "late article",
            loaderId: "httpx",
            contentType: "generic_web",
            downgraded: false,
            attempts: [],
          }
        },
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" })
  })

  it("rejects a late successful explicit built-in result", async () => {
    const source = vi.fn()
    await expect(
      loadPublicUrl("https://8.8.8.8/article", {
        ...options,
        urlContentTimeoutSeconds: 0.01,
        loader: "built-in",
        fetchImplementation: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20))
          return new Response("late article", { headers: { "content-type": "text/plain" } })
        },
        urlContentLoadImplementation: source,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" })
    expect(source).not.toHaveBeenCalled()
  })

  it("preserves automatic source errors and never falls back to built-in extraction", async () => {
    const cause = new AggregateError(
      [new LoaderContentError("CurlCffiLoader", "https://8.8.8.8/article", "transport failed")],
      "Source chain failed",
    )
    const fetchImplementation = vi.fn()
    const source = vi.fn(async () => {
      throw cause
    })
    await expect(
      loadPublicUrl("https://8.8.8.8/article", {
        ...options,
        fetchImplementation,
        urlContentTimeoutSeconds: 12,
        urlContentLoadImplementation: source,
      }),
    ).rejects.toBe(cause)
    expect(source).toHaveBeenCalledOnce()
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it.each([
    "http://127.0.0.1/private",
    "file:///etc/passwd",
    "https://user:pass@8.8.8.8/",
    "https://unsafe.example/article",
  ])("rejects unsafe automatic targets before invoking url-content: %s", async (url) => {
    const source = vi.fn()
    const fetchImplementation = vi.fn()
    await expect(
      loadPublicUrl(url, {
        ...options,
        resolve: (async () => [{ address: "10.0.0.1", family: 4 }]) as unknown as typeof lookup,
        fetchImplementation,
        urlContentTimeoutSeconds: 12,
        urlContentLoadImplementation: source,
      }),
    ).rejects.toThrow()
    expect(source).not.toHaveBeenCalled()
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it("runs only the explicitly selected built-in loader", async () => {
    const fetchImplementation = vi.fn(
      async () => new Response("plain content", { headers: { "content-type": "text/plain" } }),
    )
    const urlContentLoadImplementation = vi.fn(async () => {
      throw new Error("URL content loader should not be called")
    })

    await expect(
      loadPublicUrl("https://8.8.8.8/page", {
        ...options,
        loader: "built-in",
        fetchImplementation,
        urlContentTimeoutSeconds: 12,
        urlContentLoadImplementation,
      }),
    ).resolves.toMatchObject({ source: "built-in", text: "plain content" })
    expect(fetchImplementation).toHaveBeenCalledOnce()
    expect(urlContentLoadImplementation).not.toHaveBeenCalled()
  })

  it("runs only the explicitly selected URL content loader", async () => {
    const signal = new AbortController().signal
    const fetchImplementation = vi.fn()
    const urlContentLoadImplementation = vi.fn(async () => ({
      content: "explicit content",
      loaderId: "httpx",
      contentType: "generic_web",
      downgraded: false,
      attempts: [],
    }))

    await expect(
      loadPublicUrl("https://8.8.8.8/page", {
        ...options,
        maxChars: 8,
        loader: "httpx",
        signal,
        fetchImplementation,
        urlContentTimeoutSeconds: 12,
        urlContentLoadImplementation,
      }),
    ).resolves.toMatchObject({
      source: "url-content",
      loaderId: "httpx",
      text: "explicit\n\n[truncated by telegramagent: 16 -> 8 chars]",
      truncated: true,
    })
    expect(fetchImplementation).not.toHaveBeenCalled()
    expect(urlContentLoadImplementation).toHaveBeenCalledExactlyOnceWith("https://8.8.8.8/page", {
      allowedSchemes: options.allowedSchemes,
      deadlineSeconds: expect.any(Number),
      loaderNames: ["httpx"],
      signal: expect.any(AbortSignal),
    })
  })

  it("keeps the document heading in bounded source-aware output after removing page assets", async () => {
    const html = `<script>${"window.siteData = 'noise';".repeat(650)}</script>
      <style>${".navigation { color: red; }".repeat(650)}</style>
      <main><h1>Model guidance</h1><p>${"Read this documentation. ".repeat(40)}</p></main>`
    const content = htmlToMarkdown(html)
    const maxChars = 96
    const urlContentLoadImplementation = vi.fn(async () => ({
      content,
      loaderId: "curl-cffi",
      contentType: "generic_web",
      downgraded: false,
      attempts: [],
    }))

    const result = await loadPublicUrl("https://8.8.8.8/guide", {
      ...options,
      maxChars,
      urlContentTimeoutSeconds: 12,
      urlContentLoadImplementation,
    })

    expect(result).toMatchObject({ source: "url-content", loaderId: "curl-cffi", truncated: true })
    expect(result.text.slice(0, maxChars)).toContain("# Model guidance")
    expect(result.text).not.toContain("window.siteData")
    expect(result.text).not.toContain(".navigation")
    expect(result.text).toBe(
      `${content.slice(0, maxChars)}\n\n[truncated by telegramagent: ${content.length} -> ${maxChars} chars]`,
    )
    expect(urlContentLoadImplementation).toHaveBeenCalledExactlyOnceWith("https://8.8.8.8/guide", {
      allowedSchemes: options.allowedSchemes,
      deadlineSeconds: expect.any(Number),
      signal: expect.any(AbortSignal),
    })
  })

  it("does not fall back when an explicit URL content loader fails", async () => {
    const cause = new Error("explicit loader failed")
    const fetchImplementation = vi.fn()
    const urlContentLoadImplementation = vi.fn(async () => {
      throw cause
    })

    await expect(
      loadPublicUrl("https://8.8.8.8/page", {
        ...options,
        loader: "httpx",
        fetchImplementation,
        urlContentTimeoutSeconds: 12,
        urlContentLoadImplementation,
      }),
    ).rejects.toBe(cause)
    expect(fetchImplementation).not.toHaveBeenCalled()
    expect(urlContentLoadImplementation).toHaveBeenCalledOnce()
  })

  it("delegates PDF extraction with bounded output and the configured deadline", async () => {
    const fetchImplementation = vi.fn(async () => {
      return new Response("%PDF", { headers: { "content-type": "application/pdf" } })
    })
    const urlContentLoadImplementation = vi.fn(async () => ({
      content: "abcdef",
      loaderId: "pdf",
      contentType: "markdown",
      downgraded: false,
      attempts: [],
    }))

    await expect(
      loadPublicUrl("https://8.8.8.8/file.pdf", {
        ...options,
        maxChars: 3,
        fetchImplementation,
        urlContentTimeoutSeconds: 12,
        urlContentLoadImplementation,
      }),
    ).resolves.toMatchObject({
      source: "url-content",
      loaderId: "pdf",
      contentType: "markdown",
      text: "abc\n\n[truncated by telegramagent: 6 -> 3 chars]",
      truncated: true,
    })
    expect(fetchImplementation).not.toHaveBeenCalled()
    expect(urlContentLoadImplementation).toHaveBeenCalledWith("https://8.8.8.8/file.pdf", {
      allowedSchemes: options.allowedSchemes,
      deadlineSeconds: expect.any(Number),
      signal: expect.any(AbortSignal),
    })
  })

  it("uses the URL content loader for source-specific URLs", async () => {
    const resolve = vi.fn(async () => [
      { address: "8.8.8.8", family: 4 as const },
    ]) as unknown as typeof lookup
    const fetchImplementation = vi.fn(async () => {
      return new Response("<html><body>YouTube shell</body></html>", {
        headers: { "content-type": "text/html" },
      })
    })
    const urlContentLoadImplementation = vi.fn(async () => ({
      content: "video transcript",
      loaderId: "youtube",
      contentType: "youtube_video",
      downgraded: false,
      attempts: [],
    }))

    await expect(
      loadPublicUrl("https://youtu.be/dQw4w9WgXcQ", {
        ...options,
        resolve,
        fetchImplementation,
        urlContentTimeoutSeconds: 30,
        urlContentLoadImplementation,
      }),
    ).resolves.toMatchObject({
      source: "url-content",
      loaderId: "youtube",
      text: "video transcript",
    })
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it("routes Threads posts directly to source-aware metadata extraction", async () => {
    const url = "https://www.threads.com/@ha_haha_1229/post/Ddi8GHWk1ga"
    const resolve = vi.fn(async () => [
      { address: "8.8.8.8", family: 4 as const },
    ]) as unknown as typeof lookup
    const fetchImplementation = vi.fn()
    const urlContentLoadImplementation = vi.fn(async () => ({
      content: "# Hana (@ha_haha_1229)\n\nPost body",
      loaderId: "threads",
      contentType: "social_post",
      downgraded: false,
      attempts: [],
    }))

    await expect(
      loadPublicUrl(url, {
        ...options,
        resolve,
        fetchImplementation,
        urlContentTimeoutSeconds: 30,
        urlContentLoadImplementation,
      }),
    ).resolves.toMatchObject({
      source: "url-content",
      loaderId: "threads",
      contentType: "social_post",
      text: "# Hana (@ha_haha_1229)\n\nPost body",
    })
    expect(fetchImplementation).not.toHaveBeenCalled()
    expect(urlContentLoadImplementation).toHaveBeenCalledExactlyOnceWith(url, {
      allowedSchemes: options.allowedSchemes,
      deadlineSeconds: expect.any(Number),
      signal: expect.any(AbortSignal),
    })
  })

  it("routes Threads share links through verified post extraction and never accepts generic results", async () => {
    const url = "https://www.threads.com/share/_mwJv9S32/"
    const resolve = vi.fn(async () => [
      { address: "8.8.8.8", family: 4 as const },
    ]) as unknown as typeof lookup
    const fetchImplementation = vi.fn()
    const verified = vi.fn(async () => ({
      content: "# Author (@author)\n\n- URL: https://www.threads.com/@author/post/Abc\n\nPost body",
      loaderId: "threads",
      contentType: "social_post",
      downgraded: false,
      attempts: [{ loaderId: "threads", status: "success" as const, elapsedSeconds: 0 }],
    }))
    await expect(
      loadPublicUrl(url, {
        ...options,
        resolve,
        fetchImplementation,
        urlContentTimeoutSeconds: 30,
        urlContentLoadImplementation: verified,
      }),
    ).resolves.toMatchObject({ loaderId: "threads", contentType: "social_post" })
    expect(fetchImplementation).not.toHaveBeenCalled()
    expect(verified).toHaveBeenCalledWith(url, {
      allowedSchemes: options.allowedSchemes,
      deadlineSeconds: expect.any(Number),
      signal: expect.any(AbortSignal),
    })

    for (const loader of [undefined, "httpx", "firecrawl"]) {
      await expect(
        loadPublicUrl(url, {
          ...options,
          resolve,
          fetchImplementation,
          urlContentTimeoutSeconds: 30,
          ...(loader ? { loader } : {}),
          urlContentLoadImplementation: async () => ({
            content: "Threads",
            loaderId: loader ?? "playwright-networkidle",
            contentType: "generic_web",
            downgraded: false,
            attempts: [],
          }),
        }),
      ).rejects.toThrow("requires verified post metadata")
    }
    await expect(
      loadPublicUrl(url, {
        ...options,
        resolve,
        fetchImplementation,
        urlContentTimeoutSeconds: 30,
        loader: "built-in",
      }),
    ).rejects.toThrow("requires verified post metadata")
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it.each([
    {
      url: "https://docs.google.com/document/d/test-doc_123/edit?tab=t.0",
      loaderId: "google-docs",
    },
    { url: "https://example.com/report.docx", loaderId: "anydoc" },
    { url: "https://example.com/data.csv", loaderId: "anydoc" },
  ])(
    "routes $url directly to its document loader with output bounds and cancellation",
    async ({ url, loaderId }) => {
      const signal = new AbortController().signal
      const resolve = vi.fn(async () => [
        { address: "8.8.8.8", family: 4 as const },
      ]) as unknown as typeof lookup
      const fetchImplementation = vi.fn(
        async () =>
          new Response("<html><body>Editor shell</body></html>", {
            headers: { "content-type": "text/html" },
          }),
      )
      const urlContentLoadImplementation = vi.fn(async () => ({
        content: "document body",
        loaderId,
        contentType: "document_text",
        downgraded: false,
        attempts: [],
      }))

      await expect(
        loadPublicUrl(url, {
          ...options,
          maxChars: 8,
          resolve,
          signal,
          fetchImplementation,
          urlContentTimeoutSeconds: 30,
          urlContentLoadImplementation,
        }),
      ).resolves.toMatchObject({
        url,
        finalUrl: url,
        source: "url-content",
        loaderId,
        contentType: "document_text",
        text: "document\n\n[truncated by telegramagent: 13 -> 8 chars]",
        truncated: true,
      })
      expect(fetchImplementation).not.toHaveBeenCalled()
      expect(urlContentLoadImplementation).toHaveBeenCalledExactlyOnceWith(url, {
        allowedSchemes: options.allowedSchemes,
        deadlineSeconds: expect.any(Number),
        signal: expect.any(AbortSignal),
      })
    },
  )

  it("preserves Google Docs errors rather than accepting editor HTML or hiding the cause", async () => {
    const cause = new Error("Google Docs export returned HTTP 403")
    const fetchImplementation = vi.fn()
    const urlContentLoadImplementation = vi.fn(async () => {
      throw cause
    })
    await expect(
      loadPublicUrl("https://docs.google.com/document/d/test-doc_123/preview", {
        ...options,
        resolve: (async () => [{ address: "8.8.8.8", family: 4 }]) as unknown as typeof lookup,
        fetchImplementation,
        urlContentTimeoutSeconds: 30,
        urlContentLoadImplementation,
      }),
    ).rejects.toBe(cause)
    expect(fetchImplementation).not.toHaveBeenCalled()
    expect(urlContentLoadImplementation).toHaveBeenCalledOnce()
  })

  it("validates Google Docs DNS before invoking the dedicated loader", async () => {
    const urlContentLoadImplementation = vi.fn()
    await expect(
      loadPublicUrl("https://docs.google.com/document/d/test-doc_123/edit", {
        ...options,
        resolve: (async () => [{ address: "10.0.0.1", family: 4 }]) as unknown as typeof lookup,
        urlContentTimeoutSeconds: 30,
        urlContentLoadImplementation,
      }),
    ).rejects.toThrow("private")
    expect(urlContentLoadImplementation).not.toHaveBeenCalled()
  })

  it("rejects unsafe targets before invoking an explicit URL content loader", async () => {
    const urlContentLoadImplementation = vi.fn(async () => {
      throw new Error("URL content loader should not be called")
    })

    await expect(
      loadPublicUrl("http://127.0.0.1/private", {
        ...options,
        loader: "httpx",
        urlContentTimeoutSeconds: 12,
        urlContentLoadImplementation,
      }),
    ).rejects.toThrow("Private")
    expect(urlContentLoadImplementation).not.toHaveBeenCalled()
  })
})
