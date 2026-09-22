import { afterEach, describe, expect, it, vi } from "vitest"
import { main, parseArgs } from "../src/cli.js"
import { UrlContentClient } from "../src/client.js"
import { MissingRequirementError } from "../src/core/errors.js"

const originalFirecrawlApiKey = process.env.FIRECRAWL_API_KEY
afterEach(() => {
  if (originalFirecrawlApiKey === undefined) delete process.env.FIRECRAWL_API_KEY
  else process.env.FIRECRAWL_API_KEY = originalFirecrawlApiKey
})

describe("UrlContentClient", () => {
  it("validates options and requires explicit lifecycle start", async () => {
    expect(() => new UrlContentClient({ deadlineSeconds: 0 })).toThrow("positive")
    expect(() => new UrlContentClient({ workerLimit: 0 })).toThrow("limits")
    const client = new UrlContentClient()
    await expect(client.loadUrl("https://example.com")).rejects.toThrow("start")
  })

  it("rejects invalid and private targets before planning", async () => {
    const fetchImplementation = vi.fn()
    const client = new UrlContentClient({ fetchImplementation }).start()
    await expect(client.loadUrl("not-a-valid-url")).rejects.toThrow("HTTP(S)")
    await expect(client.loadUrl("http://127.0.0.1/private")).rejects.toThrow("Private")
    expect(fetchImplementation).not.toHaveBeenCalled()
    await client.close()
  })

  it("rejects targets whose hostname resolves to a private address", async () => {
    const client = new UrlContentClient({
      resolve: async () => [{ address: "10.0.0.1", family: 4 }],
    }).start()
    await expect(client.loadUrl("https://public.example/private")).rejects.toThrow("private")
    await client.close()
  })

  it("continues to accept a positional cancellation signal", async () => {
    const reason = new Error("cancelled")
    const controller = new AbortController()
    controller.abort(reason)
    const client = new UrlContentClient({
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    }).start()
    try {
      await expect(client.loadUrl("https://example.com", controller.signal)).rejects.toBe(reason)
    } finally {
      await client.close()
    }
  })

  it("runs only the explicitly requested loader with shared client resources", async () => {
    const fetchImplementation = vi.fn(
      async () =>
        new Response("<main>explicit result</main>", {
          headers: { "content-type": "text/html" },
        }),
    )
    const client = new UrlContentClient({
      fetchImplementation,
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    }).start()
    try {
      await expect(
        client.loadUrlDetailed("https://example.com/article", { loaderNames: ["httpx"] }),
      ).resolves.toMatchObject({
        content: "explicit result",
        loaderId: "httpx",
        attempts: [{ loaderId: "httpx", status: "success" }],
      })
      expect(fetchImplementation).toHaveBeenCalledOnce()
    } finally {
      await client.close()
    }
  })

  it("preserves registry content types for explicit source loaders", async () => {
    const fetchImplementation = vi.fn(
      async () =>
        new Response("source content", {
          headers: { "content-type": "text/plain" },
        }),
    )
    const client = new UrlContentClient({
      fetchImplementation,
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    }).start()
    try {
      await expect(
        client.loadUrlDetailed("https://github.com/example/repository/blob/main/README.md", {
          loaderNames: ["github"],
        }),
      ).resolves.toMatchObject({
        content: "source content",
        loaderId: "github",
        contentType: "code_content",
      })
      expect(fetchImplementation).toHaveBeenCalledOnce()
    } finally {
      await client.close()
    }
  })

  it("checks registry requirements before running an explicit loader", async () => {
    delete process.env.FIRECRAWL_API_KEY
    const fetchImplementation = vi.fn()
    const resolve = vi.fn(async () => [{ address: "8.8.8.8", family: 4 as const }])
    const client = new UrlContentClient({ fetchImplementation, resolve }).start()
    try {
      await expect(
        client.loadUrl("https://example.com", { loaderNames: ["firecrawl"] }),
      ).rejects.toBeInstanceOf(MissingRequirementError)
      expect(resolve).not.toHaveBeenCalled()
      expect(fetchImplementation).not.toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })

  it("does not fall back after an explicit loader fails", async () => {
    const fetchImplementation = vi.fn(
      async () => new Response("", { headers: { "content-type": "text/html" } }),
    )
    const client = new UrlContentClient({
      fetchImplementation,
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    }).start()
    try {
      await expect(
        client.loadUrl("https://example.com/empty", { loaderNames: ["httpx"] }),
      ).rejects.toThrow("Failed to load URL")
      expect(fetchImplementation).toHaveBeenCalledOnce()
    } finally {
      await client.close()
    }
  })

  it("rejects an unknown explicit loader before resolving the target", async () => {
    const resolve = vi.fn(async () => [{ address: "8.8.8.8", family: 4 as const }])
    const client = new UrlContentClient({ resolve }).start()
    try {
      await expect(
        client.loadUrl("https://example.com", { loaderNames: ["unknown-loader"] }),
      ).rejects.toThrow("Unknown loader: unknown-loader")
      expect(resolve).not.toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })
})

describe("CLI", () => {
  it("parses explicit loader lists", () => {
    expect(parseArgs(["--loader", "httpx,curl-cffi", "https://example.com"])).toEqual({
      list: false,
      loaderNames: ["httpx", "curl-cffi"],
      url: "https://example.com",
    })
  })

  it("passes explicit loader lists to the public loading API", async () => {
    const load = vi.fn(async () => "loaded content")
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    try {
      await main(
        ["--loader", "httpx,curl-cffi", "https://example.com"],
        load as typeof import("../src/api.js").loadUrl,
      )
      expect(load).toHaveBeenCalledExactlyOnceWith("https://example.com", {
        loaderNames: ["httpx", "curl-cffi"],
      })
      expect(log).toHaveBeenCalledWith("loaded content")
    } finally {
      log.mockRestore()
    }
  })

  it("lists only public loaders", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    await main(["--list"])
    const output = log.mock.calls.flat().join("\n")
    log.mockRestore()
    expect(output).toContain("anydoc -")
    expect(output).toContain("google-docs -")
    expect(output).toContain("pi-session -")
    expect(output).toContain("threads -")
    expect(output).toContain("curl-cffi -")
    expect(output).not.toContain("playwright-networkidle -")
  })
})
