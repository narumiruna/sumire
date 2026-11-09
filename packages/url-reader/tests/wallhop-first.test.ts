import { afterEach, describe, expect, it, vi } from "vitest"

import { explainPlan } from "../src/api.js"
import { UrlContentClient } from "../src/client.js"
import { LoaderContentError } from "../src/core/errors.js"
import { withDeadline } from "../src/core/execution.js"
import { getInterruptedAttempts } from "../src/core/interruption.js"
import type { LoaderFactory } from "../src/core/loader.js"
import type { FetchImplementation } from "../src/core/network.js"
import { resolveExplicitLoadChain, resolveLoadChain } from "../src/load-chain.js"
import { getLoaderContentType } from "../src/loader-registry.js"
import { GENERIC_HTML_LOADERS, planForUrl } from "../src/pipelines/catalog.js"
import {
  sharedWallhopRuleset,
  WALLHOP_RULESET_URL,
  type WallhopRuleset,
  WallhopRulesetCache,
  type WallhopRulesetProvider,
} from "../src/sources/wallhop-ruleset.js"

const articleUrl =
  "https://www.nytimes.com/2026/11/06/us/politics/chinese-spy-agency-nvidia-jensen-huang.html"
const rawUrl = `https://wallhop.io/raw/${articleUrl}`
const genericUrl = "https://www.ft.com/content/synthetic-article"
const rules: WallhopRuleset = [
  { domains: ["www.nytimes.com", "ft.com"], paths: [] },
  { domains: ["americanbanker.com"], paths: ["/news"] },
]
const originalHtml =
  '<article><section name="articleBody"><p>Original article text.</p></section></article>'
const readerHtml = `<a class="source" href="${articleUrl}">Original</a>
  <article><h1>Synthetic article</h1><div class="body"><p>Wallhop article text.</p></div></article>`
const htmlResponse = (body: string) =>
  new Response(body, { headers: { "content-type": "text/html" } })
const publicResolver = async () => [{ address: "8.8.8.8", family: 4 }]

function provider(snapshot: WallhopRuleset = rules): WallhopRulesetProvider {
  return { current: () => snapshot, load: vi.fn(async () => snapshot) }
}

function factories(succeed: string, stall?: string) {
  const calls: Array<{ name: string; url: string; signal?: AbortSignal }> = []
  const getFactory =
    (name: string): LoaderFactory =>
    () => ({
      load: async (url, signal) => {
        calls.push({ name, url, signal })
        if (name === stall) return new Promise<string>(() => {})
        if (name === succeed) return "Synthetic article text"
        throw new LoaderContentError(name, url, "Synthetic failure")
      },
    })
  return { calls, getFactory }
}

function fakeClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("Wallhop-first planning", () => {
  it("prepends Wallhop without changing the original news contract", () => {
    const base = planForUrl(articleUrl, { wallhopRules: [] })
    expect(planForUrl(articleUrl, { wallhopRules: rules })).toEqual({
      ...base,
      targetedLoaders: ["wallhop", "nytimes"],
      executionPlan: ["wallhop", "nytimes"],
    })
    expect(explainPlan(articleUrl, { wallhopRules: rules })).toMatchObject({
      pipeline: "nytimes",
      content_type: "news_article",
      execution_plan: ["wallhop", "nytimes"],
    })
  })

  it("keeps generic fallbacks and opted-in Firecrawl in their original order", () => {
    expect(planForUrl(genericUrl, { wallhopRules: rules }).pipelineName).toBeUndefined()
    expect(planForUrl(genericUrl, { wallhopRules: rules })).toMatchObject({
      contentType: "generic_web",
      contentContract: "generic_html",
      targetedLoaders: ["wallhop"],
      fallbackLoaders: GENERIC_HTML_LOADERS,
      executionPlan: ["wallhop", ...GENERIC_HTML_LOADERS],
    })
    expect(
      planForUrl(genericUrl, { wallhopRules: rules, firecrawlFallback: true }).executionPlan,
    ).toEqual(["wallhop", ...GENERIC_HTML_LOADERS, "firecrawl"])
  })

  it.each([
    "https://example.com/article",
    "https://notft.com/article",
    "https://www.ft.com.attacker.test/article",
    "https://americanbanker.com/opinion/article",
  ])("does not change unmatched planning: %s", (url) => {
    expect(planForUrl(url, { wallhopRules: rules })).toEqual(planForUrl(url, { wallhopRules: [] }))
  })

  it("matches allowed path prefixes, but does not preempt documents or explicit Wallhop links", () => {
    expect(
      planForUrl("https://americanbanker.com/news/synthetic", { wallhopRules: rules })
        .executionPlan[0],
    ).toBe("wallhop")
    for (const url of [
      "https://www.ft.com/report.pdf",
      "https://www.ft.com/report.docx",
      `https://wallhop.io/${articleUrl}`,
    ]) {
      expect(planForUrl(url, { wallhopRules: rules })).toEqual(
        planForUrl(url, { wallhopRules: [] }),
      )
    }
    const socialRules = [{ domains: ["www.youtube.com"], paths: [] }]
    expect(
      planForUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ", { wallhopRules: socialRules })
        .executionPlan,
    ).toEqual(["youtube", "youtube-ytdlp"])
  })

  it("keeps synchronous explanations network-free and uses the current cached snapshot", () => {
    const current = vi.spyOn(sharedWallhopRuleset, "current").mockReturnValue([])
    const load = vi.spyOn(sharedWallhopRuleset, "load")
    expect(explainPlan(articleUrl).execution_plan).toEqual(["nytimes"])
    current.mockReturnValue(rules)
    expect(explainPlan(articleUrl).execution_plan).toEqual(["wallhop", "nytimes"])
    expect(load).not.toHaveBeenCalled()
  })
})

describe("Wallhop-first execution", () => {
  it("wraps only the added attempt and stops after success", async () => {
    const { calls, getFactory } = factories("wallhop")
    const result = await resolveLoadChain(articleUrl, {
      wallhopRules: rules,
      getFactory,
    }).loadDetailed()
    expect(result).toMatchObject({
      loaderId: "wallhop",
      contentType: "news_article",
      downgraded: false,
    })
    expect(calls.map(({ name, url }) => ({ name, url }))).toEqual([
      { name: "wallhop", url: `https://wallhop.io/${articleUrl}` },
    ])
  })

  it.each([
    [articleUrl, "nytimes"],
    [genericUrl, "curl-cffi"],
  ])("returns to the original chain and URL after failure: %s", async (url, fallback) => {
    const { calls, getFactory } = factories(fallback)
    const result = await resolveLoadChain(url, { wallhopRules: rules, getFactory }).loadDetailed()
    expect(result.loaderId).toBe(fallback)
    expect(calls.map(({ name, url }) => ({ name, url }))).toEqual([
      { name: "wallhop", url: `https://wallhop.io/${url}` },
      { name: fallback, url },
    ])
    expect(result.attempts).toMatchObject([
      { loaderId: "wallhop", status: "failed" },
      { loaderId: fallback, status: "success" },
    ])
  })

  it("preserves query encoding and sends the original input to fallback", async () => {
    const url = `${articleUrl}?share=one%2Ftwo&item=1&item=2#comments`
    const { calls, getFactory } = factories("nytimes")
    await resolveLoadChain(url, { wallhopRules: rules, getFactory }).load()
    expect(calls[0]?.url).toBe(`https://wallhop.io/${url}`)
    expect(calls[1]?.url).toBe(url)
  })

  it.each([
    [articleUrl, "nytimes", 500],
    [genericUrl, "curl-cffi", 200],
  ])("reserves a fair deadline share for fallback: %s", async (url, fallback, elapsed) => {
    fakeClock()
    const { calls, getFactory } = factories(fallback, "wallhop")
    const loading = withDeadline(performance.now() + 1_000, () =>
      resolveLoadChain(url, { wallhopRules: rules, getFactory }).loadDetailed(),
    )
    await vi.advanceTimersByTimeAsync(elapsed)
    const result = await loading
    expect(result.loaderId).toBe(fallback)
    expect(result.attempts[0]).toMatchObject({
      loaderId: "wallhop",
      status: "timeout",
      elapsedSeconds: elapsed / 1_000,
    })
    expect(calls[0]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("caps the preference at ten seconds without a shared deadline", async () => {
    fakeClock()
    const { getFactory } = factories("nytimes", "wallhop")
    const loading = resolveLoadChain(articleUrl, { wallhopRules: rules, getFactory }).loadDetailed()
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await loading).loaderId).toBe("nytimes")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not weaken a source-required content contract", async () => {
    const { getFactory } = factories("wallhop")
    const error = await resolveLoadChain(articleUrl, {
      wallhopRules: rules,
      getFactory,
      getContentType: (name) => (name === "wallhop" ? "generic_web" : getLoaderContentType(name)),
    })
      .loadDetailed()
      .catch((error: unknown) => error)
    expect(error).toMatchObject({
      attempts: [
        { loaderId: "wallhop", status: "rejected" },
        { loaderId: "nytimes", status: "failed" },
      ],
    })
  })

  it("checks eligibility after augmenting a plan with an otherwise unavailable base loader", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", undefined)
    const { calls, getFactory } = factories("wallhop")
    const chain = resolveLoadChain("https://openai.com/index/synthetic", {
      wallhopRules: [{ domains: ["openai.com"], paths: [] }],
      firecrawlApiKey: null,
      getFactory,
    })
    expect(chain.explanation.eligibleLoaders).toEqual(["wallhop"])
    expect((await chain.loadDetailed()).loaderId).toBe("wallhop")
    expect(calls).toHaveLength(1)
  })

  it("does not alter explicit chains or preserve an automatic preference in them", async () => {
    const { calls, getFactory } = factories("nytimes")
    await resolveExplicitLoadChain(articleUrl, ["nytimes"], { getFactory }).load()
    expect(calls.map(({ name, url }) => ({ name, url }))).toEqual([
      { name: "nytimes", url: articleUrl },
    ])
  })

  it("preserves cancellation and does not start fallback", async () => {
    fakeClock()
    const controller = new AbortController()
    const reason = new Error("Synthetic cancellation")
    const { calls, getFactory } = factories("nytimes", "wallhop")
    const loading = resolveLoadChain(articleUrl, { wallhopRules: rules, getFactory }).loadDetailed(
      controller.signal,
    )
    const rejected = expect(loading).rejects.toBe(reason)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(reason)
    await rejected
    expect(calls).toHaveLength(1)
    expect(getInterruptedAttempts(reason, articleUrl)).toMatchObject([
      { loaderId: "wallhop", status: "cancelled" },
    ])
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("automatic Wallhop client preparation", () => {
  it("fetches and caches rules, then loads the original URL through Wallhop", async () => {
    const fetchImplementation = vi.fn<FetchImplementation>(async (input) => {
      if (String(input) === WALLHOP_RULESET_URL)
        return new Response("- domain: www.nytimes.com", {
          headers: { "content-type": "text/plain" },
        })
      expect(String(input)).toBe(rawUrl)
      return htmlResponse(readerHtml)
    })
    await using client = new UrlContentClient({
      fetchImplementation,
      resolve: publicResolver,
      wallhopRuleset: new WallhopRulesetCache(),
    }).start()
    for (let i = 0; i < 2; i += 1) {
      await expect(client.loadUrlDetailed(articleUrl)).resolves.toMatchObject({
        content: expect.stringContaining("Wallhop article text."),
        loaderId: "wallhop",
        contentType: "news_article",
        downgraded: false,
        attempts: [{ loaderId: "wallhop", status: "success" }],
      })
    }
    expect(fetchImplementation.mock.calls.map(([url]) => String(url))).toEqual([
      WALLHOP_RULESET_URL,
      rawUrl,
      rawUrl,
    ])
  })

  it.each([503, "challenge"] as const)(
    "uses the original NYTimes loader after Wallhop %s",
    async (failure) => {
      const fetchImplementation = vi.fn<FetchImplementation>(async (input) => {
        if (String(input) === rawUrl)
          return failure === "challenge"
            ? htmlResponse("<main>Challenge</main>")
            : new Response(null, { status: failure })
        expect(String(input)).toBe(articleUrl)
        return htmlResponse(originalHtml)
      })
      await using client = new UrlContentClient({
        fetchImplementation,
        resolve: publicResolver,
        wallhopRuleset: provider(),
      }).start()
      const result = await client.loadUrlDetailed(articleUrl)
      expect(result).toMatchObject({
        content: "Original article text.",
        loaderId: "nytimes",
        contentType: "news_article",
        downgraded: false,
        attempts: [
          { loaderId: "wallhop", status: "failed" },
          { loaderId: "nytimes:httpx", status: "success" },
          { loaderId: "nytimes", status: "success" },
        ],
      })
      expect(fetchImplementation.mock.calls.map(([url]) => String(url))).toEqual([
        rawUrl,
        articleUrl,
      ])
    },
  )

  it.each(["invalid YAML", "redirect", "unavailable"])(
    "keeps original loading when rules are %s",
    async (failure) => {
      const fetchImplementation = vi.fn<FetchImplementation>(async (input) => {
        if (String(input) === WALLHOP_RULESET_URL) {
          if (failure === "redirect")
            return new Response(null, {
              status: 302,
              headers: { location: "http://127.0.0.1/private" },
            })
          if (failure === "unavailable") return new Response(null, { status: 503 })
          return new Response("<html>Not YAML</html>", {
            headers: { "content-type": "text/plain" },
          })
        }
        expect(String(input)).toBe(articleUrl)
        return htmlResponse(originalHtml)
      })
      await using client = new UrlContentClient({
        fetchImplementation,
        resolve: publicResolver,
        wallhopRuleset: new WallhopRulesetCache(),
      }).start()
      await expect(client.loadUrlDetailed(articleUrl)).resolves.toMatchObject({
        loaderId: "nytimes",
      })
      expect(fetchImplementation.mock.calls.map(([url]) => String(url))).toEqual([
        WALLHOP_RULESET_URL,
        articleUrl,
      ])
    },
  )

  it("bounds metadata waiting without occupying the fallback request slot", async () => {
    fakeClock()
    const fetchImplementation = vi.fn<FetchImplementation>(async (input) => {
      if (String(input) === WALLHOP_RULESET_URL) return new Promise<Response>(() => {})
      expect(String(input)).toBe(articleUrl)
      return htmlResponse(originalHtml)
    })
    await using client = new UrlContentClient({
      deadlineSeconds: 1,
      requestLimit: 1,
      fetchImplementation,
      resolve: publicResolver,
      wallhopRuleset: new WallhopRulesetCache(),
    }).start()
    const loading = client.loadUrlDetailed(articleUrl)
    await vi.advanceTimersByTimeAsync(250)
    await expect(loading).resolves.toMatchObject({ loaderId: "nytimes" })
    expect(fetchImplementation.mock.calls.map(([url]) => String(url))).toEqual([
      WALLHOP_RULESET_URL,
      articleUrl,
    ])
    await vi.advanceTimersByTimeAsync(1750)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("does not refresh rules for an explicit override, even with matching cached data", async () => {
    const source = provider()
    const fetchImplementation = vi.fn(async () => htmlResponse(originalHtml))
    await using client = new UrlContentClient({
      fetchImplementation,
      resolve: publicResolver,
      wallhopRuleset: source,
    }).start()
    await expect(
      client.loadUrlDetailed(articleUrl, { loaderNames: ["nytimes"] }),
    ).resolves.toMatchObject({ loaderId: "nytimes" })
    expect(source.load).not.toHaveBeenCalled()
    expect(fetchImplementation).toHaveBeenCalledOnce()
  })

  it.each([
    "http://127.0.0.1/private",
    "https://user:pass@www.nytimes.com/story",
    "https://private.example/story",
  ])("validates targets before any metadata request: %s", async (url) => {
    const source = provider()
    const fetchImplementation = vi.fn()
    await using client = new UrlContentClient({
      fetchImplementation,
      wallhopRuleset: source,
      resolve: async (host) =>
        host === "private.example" ? [{ address: "10.0.0.1", family: 4 }] : publicResolver(),
    }).start()
    await expect(client.loadUrlDetailed(url)).rejects.toThrow()
    expect(source.load).not.toHaveBeenCalled()
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it("does not add an HTTPS service when the client permits only HTTP", async () => {
    const source = provider()
    const fetchImplementation = vi.fn(async () => htmlResponse(originalHtml))
    await using client = new UrlContentClient({
      allowedSchemes: new Set(["http"]),
      fetchImplementation,
      resolve: publicResolver,
      wallhopRuleset: source,
    }).start()
    await expect(
      client.loadUrlDetailed(articleUrl.replace("https:", "http:")),
    ).resolves.toMatchObject({ loaderId: "nytimes" })
    expect(source.load).not.toHaveBeenCalled()
    expect(fetchImplementation).toHaveBeenCalledOnce()
  })

  it("preserves cancellation while preparing rules without loading the article", async () => {
    fakeClock()
    const source = provider()
    vi.mocked(source.load).mockImplementation(async () => new Promise<WallhopRuleset>(() => {}))
    const fetchImplementation = vi.fn()
    await using client = new UrlContentClient({
      fetchImplementation,
      resolve: publicResolver,
      wallhopRuleset: source,
    }).start()
    const controller = new AbortController()
    const reason = new Error("Synthetic cancelled preparation")
    const loading = client.loadUrlDetailed(articleUrl, controller.signal)
    const rejected = expect(loading).rejects.toBe(reason)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(reason)
    await rejected
    expect(source.load).toHaveBeenCalledOnce()
    expect(fetchImplementation).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
