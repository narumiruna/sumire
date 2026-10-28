import { inspect } from "node:util"
import { MissingRequirementError, UrlContentClient } from "@narumitw/sumire-url-reader"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createPublicUrlLoader, loadPublicUrl } from "../src/public-url.js"
import { normalizeUrlFailure } from "../src/url-failure.js"
import { createUrlTool } from "../src/url-tool.js"

const url = "https://8.8.8.8/article"
const oldKey = "sentinel-old-firecrawl-credential"
const newKey = "sentinel-new-firecrawl-credential"
const options = {
  allowedSchemes: new Set(["https"]),
  maxChars: 1_000,
  timeoutMs: 1_000,
  urlContentTimeoutSeconds: 5,
}
const article = (key: string) =>
  Response.json({ data: { markdown: `# Article\nEcho ${key}, repeated ${key}.` } })

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("host Firecrawl credential propagation", () => {
  it.each([undefined, null, oldKey])(
    "forwards direct load option %s without changing other options",
    async (firecrawlApiKey) => {
      const source = vi.fn(async (_url: string, _options: unknown) => ({
        content: "Article",
        loaderId: "firecrawl",
        contentType: "generic_web",
        downgraded: false,
        attempts: [],
      }))
      await loadPublicUrl(url, {
        ...options,
        loader: "firecrawl",
        firecrawlFallback: true,
        firecrawlApiKey,
        urlContentLoadImplementation: source,
      })
      expect(source).toHaveBeenCalledWith(
        url,
        expect.objectContaining({
          allowedSchemes: options.allowedSchemes,
          deadlineSeconds: expect.any(Number),
          signal: expect.any(AbortSignal),
          loaderNames: ["firecrawl"],
          firecrawlFallback: true,
          ...(firecrawlApiKey !== undefined ? { firecrawlApiKey } : {}),
        }),
      )
      if (firecrawlApiKey === undefined)
        expect(source.mock.calls[0]?.[1]).not.toHaveProperty("firecrawlApiKey")
    },
  )

  for (const env of [undefined, newKey]) {
    it.each([undefined, null, "", oldKey])(
      `plans and authorizes factory loads with key %s and environment ${env === undefined ? "absent" : "present"}`,
      async (firecrawlApiKey) => {
        vi.stubEnv("FIRECRAWL_API_KEY", env)
        const expectedKey = firecrawlApiKey === undefined ? env : firecrawlApiKey
        const fetch = vi
          .spyOn(UrlContentClient.prototype, "fetch")
          .mockImplementation(async () => article(expectedKey ?? ""))
        const loader = createPublicUrlLoader({ ...options, firecrawlApiKey })
        const pending = loader.load(url, { loader: "firecrawl" })
        if (!expectedKey) {
          await expect(pending).rejects.toBeInstanceOf(MissingRequirementError)
          expect(fetch).not.toHaveBeenCalled()
        } else {
          expect(await pending).toMatchObject({
            text: "# Article\nEcho [REDACTED], repeated [REDACTED].",
            loaderId: "firecrawl",
            attempts: [{ loaderId: "firecrawl", status: "success" }],
          })
          expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
            `Bearer ${expectedKey}`,
          )
        }
      },
    )
  }

  it("supports fresh per-load snapshots and explicit deletion on a long-lived factory", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "must-not-be-used")
    const fetch = vi
      .spyOn(UrlContentClient.prototype, "fetch")
      .mockImplementation(async (_url, init) => {
        const key = new Headers(init?.headers).get("Authorization")?.slice("Bearer ".length) ?? ""
        return article(key)
      })
    const loader = createPublicUrlLoader({ ...options, firecrawlApiKey: oldKey })
    for (const firecrawlApiKey of [undefined, newKey]) {
      const result = await loader.load(url, { loader: "firecrawl", firecrawlApiKey })
      expect(result.text).not.toContain(oldKey)
      expect(result.text).not.toContain(newKey)
    }
    expect(
      fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization")),
    ).toEqual([`Bearer ${oldKey}`, `Bearer ${newKey}`])
    await expect(
      loader.load(url, { loader: "firecrawl", firecrawlApiKey: null }),
    ).rejects.toBeInstanceOf(MissingRequirementError)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([newKey, null])(
    "redacts successful dispatched-key echoes after replacement/deletion to %s before tool results",
    async (replacement) => {
      let stored: string | null = oldKey
      const upstream = deferred<Response>()
      const dispatched = deferred<void>()
      const fetch = vi.spyOn(UrlContentClient.prototype, "fetch").mockImplementation(() => {
        dispatched.resolve(undefined)
        return upstream.promise
      })
      const hostLoader = createPublicUrlLoader(options)
      const tool = createUrlTool(
        {
          load: (url, loadOptions) =>
            hostLoader.load(url, { ...loadOptions, firecrawlApiKey: stored }),
        },
        { selectableLoaders: ["firecrawl"] },
      )
      expect(JSON.stringify(tool.parameters)).not.toContain("firecrawlApiKey")
      const pending = tool.execute(
        "call",
        { url, loader: "firecrawl" },
        undefined,
        undefined,
        undefined as never,
      )
      await dispatched.promise
      stored = replacement
      upstream.resolve(article(oldKey))
      const result = await pending
      expect(result).toMatchObject({
        details: { text: "# Article\nEcho [REDACTED], repeated [REDACTED]." },
      })
      expect(inspect(result, { depth: 12 })).not.toContain(oldKey)
      expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
        `Bearer ${oldKey}`,
      )
    },
  )

  it.each([newKey, null])(
    "drops unsafe error/diagnostic echoes after replacement/deletion to %s",
    async (replacement) => {
      let stored: string | null = oldKey
      const upstream = deferred<Response>()
      const dispatched = deferred<void>()
      vi.spyOn(UrlContentClient.prototype, "fetch").mockImplementation(() => {
        dispatched.resolve(undefined)
        return upstream.promise
      })
      const loader = createPublicUrlLoader(options)
      const pending = loader
        .load(url, { loader: "firecrawl", firecrawlApiKey: stored })
        .catch((error: unknown) => error)
      await dispatched.promise
      stored = replacement
      upstream.reject(
        Object.assign(new Error(oldKey, { cause: new Error(oldKey) }), {
          diagnostic: { code: oldKey, phase: oldKey },
          attempts: [{ loaderId: oldKey, status: oldKey, diagnostic: { code: oldKey } }],
        }),
      )
      const error = await pending
      expect(inspect(error, { depth: 12, showHidden: true })).not.toContain(oldKey)
      const safe = normalizeUrlFailure(error, url)
      expect(safe.attempts).toMatchObject([
        {
          loaderId: "firecrawl",
          status: "failed",
          diagnostic: { code: "unknown", phase: "loading" },
        },
      ])
      expect(JSON.stringify(safe)).not.toContain(oldKey)
      expect(stored).toBe(replacement)
    },
  )
})
