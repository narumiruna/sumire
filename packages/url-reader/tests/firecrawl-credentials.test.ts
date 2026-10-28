import { inspect } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"

import { explainPlan, loadUrlDetailed } from "../src/api.js"
import { UrlContentClient } from "../src/client.js"
import {
  FirecrawlApiKeyNotSetError,
  getFailureDiagnostic,
  LoaderContentError,
  MissingRequirementError,
} from "../src/core/errors.js"
import type { ResourceProvider } from "../src/core/resources.js"
import { explainLoadChain, resolveExplicitLoadChain, resolveLoadChain } from "../src/load-chain.js"
import { createLoader, getLoaderFactory, getLoaderRequirements } from "../src/loader-registry.js"
import { FirecrawlLoader } from "../src/loaders/firecrawl.js"

const url = "https://8.8.8.8/article"
const sourceUrl = "https://openai.com/index/article"
const oldKey = "sentinel-old-firecrawl-credential"
const newKey = "sentinel-new-firecrawl-credential"
const markdown = (key: string) => `# Article\nCredential echo: ${key}; repeated ${key}.`
const response = (key = oldKey) =>
  Response.json({ success: true, data: { markdown: markdown(key) } })

function resources(
  fetch: ResourceProvider["fetch"],
  validateUrl = async (target: string | URL) => new URL(target),
) {
  return { fetch, validateUrl } as ResourceProvider
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("Firecrawl credential availability", () => {
  for (const env of [undefined, "environment-credential"]) {
    describe(`environment ${env === undefined ? "absent" : "present"}`, () => {
      it.each([undefined, null, "", oldKey])(
        "uses explicit option %s consistently",
        async (key) => {
          vi.stubEnv("FIRECRAWL_API_KEY", env)
          const available = Boolean(key === undefined ? env : key)
          const options = { firecrawlApiKey: key }
          const plan = explainLoadChain(sourceUrl, options)
          expect(plan.requirements).toEqual(["FIRECRAWL_API_KEY"])
          expect(plan.eligibleLoaders).toEqual(available ? ["firecrawl"] : [])
          expect(plan.unavailableLoaders).toEqual(available ? [] : ["firecrawl"])
          expect(plan.missingRequirements).toEqual(available ? [] : ["FIRECRAWL_API_KEY"])
          expect(explainPlan(sourceUrl, options)).toMatchObject({
            eligible_loaders: plan.eligibleLoaders,
            missing_requirements: plan.missingRequirements,
          })
          const automatic = explainLoadChain(url, { ...options, firecrawlFallback: true })
          expect(automatic.eligibleLoaders.includes("firecrawl")).toBe(available)
          expect(automatic.unavailableLoaders.includes("firecrawl")).toBe(!available)
          for (const resolve of [
            () => resolveLoadChain(sourceUrl, options),
            () => resolveExplicitLoadChain(url, ["firecrawl"], options),
          ]) {
            if (available) expect(resolve().explanation.eligibleLoaders).toEqual(["firecrawl"])
            else expect(resolve).toThrow(MissingRequirementError)
          }
          if (available) {
            expect(new FirecrawlLoader({ apiKey: key }).apiKey).toBe(key ?? env)
            expect(await createLoader("firecrawl", undefined, options)).toMatchObject({
              apiKey: key ?? env,
            })
            expect(await getLoaderFactory("firecrawl", undefined, options)()).toMatchObject({
              apiKey: key ?? env,
            })
          } else {
            expect(() => new FirecrawlLoader({ apiKey: key })).toThrow(FirecrawlApiKeyNotSetError)
            await expect(createLoader("firecrawl", undefined, options)).rejects.toBeInstanceOf(
              FirecrawlApiKeyNotSetError,
            )
            await expect(
              getLoaderFactory("firecrawl", undefined, options)(),
            ).rejects.toBeInstanceOf(FirecrawlApiKeyNotSetError)
          }
        },
      )
    })
  }

  it.each([undefined, null, oldKey])(
    "checks requirements before all execution paths with %s",
    async (key) => {
      vi.stubEnv("FIRECRAWL_API_KEY", "environment-credential")
      const built: string[] = []
      const options = {
        firecrawlApiKey: key,
        getRequirements: getLoaderRequirements,
        getFactory: (name: string) => () => {
          built.push(name)
          return {
            load: async () => {
              if (name === "firecrawl") return "Article"
              throw new Error("Local loader failed")
            },
          }
        },
      }
      const chain = resolveExplicitLoadChain(url, ["firecrawl", "httpx"], options)
      if (key === null) {
        await expect(chain.loadDetailed()).rejects.toMatchObject({
          attempts: [
            {
              loaderId: "firecrawl",
              status: "skipped",
              diagnostic: { code: "configuration_missing" },
            },
            { loaderId: "httpx", status: "failed" },
          ],
        })
        expect(built).toEqual(["httpx"])
      } else {
        expect((await chain.loadDetailed()).loaderId).toBe("firecrawl")
        expect(built).toEqual(["firecrawl"])
      }
      built.length = 0
      const automatic = resolveLoadChain(url, { ...options, firecrawlFallback: true })
      if (key === null) {
        await expect(automatic.loadDetailed()).rejects.toMatchObject({
          attempts: expect.arrayContaining([
            {
              loaderId: "firecrawl",
              status: "skipped",
              elapsedSeconds: 0,
              errorType: "MissingRequirementError",
              diagnostic: { code: "configuration_missing" },
              message: "Missing requirement(s): FIRECRAWL_API_KEY",
            },
          ]),
        })
        expect(built).not.toContain("firecrawl")
      } else {
        expect((await automatic.loadDetailed()).loaderId).toBe("firecrawl")
      }
    },
  )

  it("uses custom requirements for automatic eligibility as well as execution", () => {
    vi.stubEnv("FIRECRAWL_API_KEY", oldKey)
    vi.stubEnv("UNAVAILABLE_TEST_DEPENDENCY", undefined)
    expect(() =>
      resolveLoadChain(sourceUrl, {
        firecrawlApiKey: oldKey,
        getRequirements: () => ["UNAVAILABLE_TEST_DEPENDENCY"],
      }),
    ).toThrow(MissingRequirementError)
  })
})

describe("operation-local credential propagation", () => {
  it.each([undefined, null, oldKey])("threads one-shot option %s into the client", async (key) => {
    vi.stubEnv("FIRECRAWL_API_KEY", newKey)
    const fetch = vi
      .spyOn(UrlContentClient.prototype, "fetch")
      .mockResolvedValue(response(key ?? newKey))
    const pending = loadUrlDetailed(url, { firecrawlApiKey: key, loaderNames: ["firecrawl"] })
    if (key === null) {
      await expect(pending).rejects.toBeInstanceOf(MissingRequirementError)
      expect(fetch).not.toHaveBeenCalled()
    } else {
      expect((await pending).content).toBe(markdown("[REDACTED]"))
      expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
        `Bearer ${key ?? newKey}`,
      )
    }
  })

  it("supports constructor credentials and concurrent per-load overrides without state changes", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "environment-credential")
    const authorizations: string[] = []
    await using client = new UrlContentClient({
      firecrawlApiKey: null,
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      fetchImplementation: async (_url, init) => {
        const authorization = new Headers(init?.headers).get("Authorization") ?? ""
        authorizations.push(authorization)
        return response(authorization.slice("Bearer ".length))
      },
    }).start()
    const results = await Promise.all(
      [oldKey, newKey].map((firecrawlApiKey) =>
        client.loadUrlDetailed(url, { loaderNames: ["firecrawl"], firecrawlApiKey }),
      ),
    )
    expect(results.map((result) => result.content)).toEqual([
      markdown("[REDACTED]"),
      markdown("[REDACTED]"),
    ])
    expect(authorizations.sort()).toEqual([`Bearer ${oldKey}`, `Bearer ${newKey}`].sort())
    await expect(client.loadUrl(url, { loaderNames: ["firecrawl"] })).rejects.toBeInstanceOf(
      MissingRequirementError,
    )
    await using configured = new UrlContentClient({ firecrawlApiKey: oldKey }).start()
    const fetch = vi.spyOn(configured, "fetch").mockResolvedValue(response())
    expect(await configured.loadUrl(url, { loaderNames: ["firecrawl"] })).toBe(
      markdown("[REDACTED]"),
    )
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      `Bearer ${oldKey}`,
    )
    await expect(
      configured.loadUrl(url, { loaderNames: ["firecrawl"], firecrawlApiKey: null }),
    ).rejects.toBeInstanceOf(MissingRequirementError)
  })

  it.each([newKey, undefined])(
    "retains the actual environment snapshot during rotation/deletion to %s",
    async (replacement) => {
      vi.stubEnv("FIRECRAWL_API_KEY", oldKey)
      const validation = deferred<Array<{ address: string; family: 4 }>>()
      const fetch = vi.fn<ResourceProvider["fetch"]>(async () => response())
      await using client = new UrlContentClient({
        resolve: () => validation.promise,
        fetchImplementation: fetch,
      }).start()
      const pending = client.loadUrlDetailed("https://example.com/article", {
        loaderNames: ["firecrawl"],
      })
      vi.stubEnv("FIRECRAWL_API_KEY", replacement)
      validation.resolve([{ address: "8.8.8.8", family: 4 }])
      const result = await pending
      expect(result.content).toBe(markdown("[REDACTED]"))
      expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
        `Bearer ${oldKey}`,
      )
      expect(inspect(result)).not.toContain(oldKey)
    },
  )

  it("captures environment credentials when a default-factory chain is planned", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", oldKey)
    const chain = resolveExplicitLoadChain(url, ["firecrawl"])
    vi.stubEnv("FIRECRAWL_API_KEY", newKey)
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response())
    expect((await chain.loadDetailed()).content).toBe(markdown("[REDACTED]"))
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      `Bearer ${oldKey}`,
    )
  })
})

describe("Firecrawl response credential safety", () => {
  it.each([
    ["ECONNRESET", "transport_failure"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls_certificate"],
  ])("retains safe %s diagnostics without raw causes", async (code, expected) => {
    const upstream = new Error(oldKey, { cause: Object.assign(new Error(oldKey), { code }) })
    const loader = new FirecrawlLoader({
      apiKey: oldKey,
      resources: resources(async () => {
        throw upstream
      }),
    })
    const error = await loader.load(url).catch((error: unknown) => error)
    expect(getFailureDiagnostic(error)).toEqual({ code: expected, phase: "loading" })
    expect(error).not.toHaveProperty("cause")
    expect(inspect(error, { depth: 8, showHidden: true })).not.toContain(oldKey)
  })

  it("does not expose exceptions from unsafe upstream diagnostic accessors", async () => {
    const upstream = new Error(oldKey)
    Object.defineProperty(upstream, "cause", {
      get() {
        throw new Error(oldKey)
      },
    })
    const loader = new FirecrawlLoader({
      apiKey: oldKey,
      resources: resources(async () => {
        throw upstream
      }),
    })
    const error = await loader.load(url).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(LoaderContentError)
    expect(error).not.toHaveProperty("cause")
    expect(inspect(error, { depth: 8, showHidden: true })).not.toContain(oldKey)
  })

  it("preserves direct caller cancellation with a fixed public reason", async () => {
    const controller = new AbortController()
    const fetch: ResourceProvider["fetch"] = async (_url, init) => {
      controller.abort(new Error(oldKey))
      throw init?.signal?.reason
    }
    const loader = new FirecrawlLoader({ apiKey: oldKey, resources: resources(fetch) })
    const error = await loader.load(url, controller.signal).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(DOMException)
    expect(error).toMatchObject({ name: "AbortError", message: "Firecrawl request cancelled" })
    expect(inspect(error, { depth: 8, showHidden: true })).not.toContain(oldKey)
  })

  it.each([newKey, undefined])(
    "redacts successful old-key echoes after rotation/deletion to %s",
    async (replacement) => {
      vi.stubEnv("FIRECRAWL_API_KEY", oldKey)
      const upstream = deferred<Response>()
      const fetch = vi.fn<ResourceProvider["fetch"]>(() => upstream.promise)
      const loader = new FirecrawlLoader({ resources: resources(fetch) })
      const pending = loader.load(url)
      vi.stubEnv("FIRECRAWL_API_KEY", replacement)
      upstream.resolve(
        Response.json({
          success: true,
          data: { markdown: markdown(oldKey), metadata: { description: oldKey } },
          diagnostic: { code: oldKey },
        }),
      )
      expect(await pending).toBe(markdown("[REDACTED]"))
      expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
        `Bearer ${oldKey}`,
      )
    },
  )

  it.each([
    "transport",
    "typed-error",
    "body",
    "json",
    "http",
    "envelope",
    "unsuccessful",
    "missing-markdown",
    "metadata",
    "challenge",
  ])("drops secret echoes and unsafe causes from %s failures", async (kind) => {
    const cause = Object.assign(new Error(oldKey), { diagnostic: { code: oldKey, phase: oldKey } })
    const fetch = async () => {
      if (kind === "transport") throw new Error(oldKey, { cause })
      if (kind === "typed-error")
        throw new LoaderContentError(oldKey, oldKey, oldKey, oldKey, cause)
      if (kind === "body")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(cause)
            },
          }),
        )
      if (kind === "json") return new Response(`{"echo":"${oldKey}" invalid`)
      if (kind === "http") return new Response(oldKey, { status: 401 })
      if (kind === "envelope") return Response.json([oldKey])
      if (kind === "unsuccessful")
        return Response.json({ success: false, error: oldKey, diagnostic: cause.diagnostic })
      if (kind === "missing-markdown")
        return Response.json({ data: { markdown: { secret: oldKey }, error: oldKey } })
      if (kind === "metadata")
        return Response.json({
          data: { markdown: oldKey, metadata: { sourceURL: `http://127.0.0.1/${oldKey}` } },
        })
      return Response.json({ data: { markdown: `# Just a moment... ${oldKey}` } })
    }
    vi.stubEnv("FIRECRAWL_API_KEY", oldKey)
    const upstream = deferred<Response>()
    const loader = new FirecrawlLoader({
      resources: resources(
        () => upstream.promise,
        async () => {
          throw cause
        },
      ),
    })
    const pending = loader.load(url).catch((error: unknown) => error)
    vi.stubEnv("FIRECRAWL_API_KEY", newKey)
    upstream.resolve(fetch())
    const error = await pending
    expect(error).toBeInstanceOf(LoaderContentError)
    expect(error).not.toHaveProperty("cause")
    expect(inspect(error, { depth: 8, showHidden: true })).not.toContain(oldKey)
    expect(JSON.stringify(error)).not.toContain(oldKey)
    const chain = resolveExplicitLoadChain(url, ["firecrawl"], {
      firecrawlApiKey: oldKey,
      getRequirements: getLoaderRequirements,
      getFactory: () => () =>
        new FirecrawlLoader({
          apiKey: oldKey,
          resources: resources(fetch, async () => {
            throw cause
          }),
        }),
    })
    const aggregate = await chain.loadDetailed().catch((error: unknown) => error)
    expect(inspect(aggregate, { depth: 8, showHidden: true })).not.toContain(oldKey)
    expect(JSON.stringify(aggregate)).not.toContain(oldKey)
  })
})
