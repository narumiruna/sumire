import type { Browser } from "playwright"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { UrlContentClient } from "../src/client.js"
import { LoaderContentError, LoaderNotApplicableError } from "../src/core/errors.js"
import { withAttemptSink } from "../src/core/execution.js"
import type { FetchImplementation } from "../src/core/network.js"
import type { ResourceProvider } from "../src/core/resources.js"
import type { AttemptRecord } from "../src/core/results.js"
import { availableLoaders, explainPlan, isNytimesUrl, parseNytimesTarget } from "../src/index.js"
import { createLoader, getLoaderDef } from "../src/loader-registry.js"
import { fetchBrowserHtmlResponse } from "../src/loaders/browser.js"
import { fetchImpersHtml, MAX_HTML_BYTES } from "../src/loaders/generic.js"
import { extractNytimesArticleText, NytimesLoader } from "../src/loaders/index.js"
import { planForUrl } from "../src/pipelines/catalog.js"

vi.mock("../src/loaders/generic.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/loaders/generic.js")>()),
  fetchImpersHtml: vi.fn(),
}))

vi.mock("../src/loaders/browser.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/loaders/browser.js")>()),
  fetchBrowserHtmlResponse: vi.fn(),
}))

const articleUrl =
  "https://www.nytimes.com/2026/11/06/us/politics/chinese-spy-agency-nvidia-jensen-huang.html"
const articleHtml = '<article><section name="articleBody"><p>Article body.</p></section></article>'
const htmlResponse = (body: string) =>
  new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } })
const publicResolver = async () => [{ address: "8.8.8.8", family: 4 }]

function resourcesWithFetch(fetch: FetchImplementation): ResourceProvider {
  return {
    fetch,
    browser: vi.fn(async () => ({}) as Browser),
    runBrowser: vi.fn(async (operation: () => Promise<unknown>) => operation()),
    validateUrl: vi.fn(async (input: string | URL) => new URL(input)),
  } as unknown as ResourceProvider
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(fetchImpersHtml).mockRejectedValue(new Error("Impersonated transport unavailable"))
  vi.mocked(fetchBrowserHtmlResponse).mockRejectedValue(new Error("Browser transport unavailable"))
})

describe("New York Times applicability and registration", () => {
  it.each([
    articleUrl,
    `${articleUrl}?unlocked_article_code=public-share#commentsContainer`,
    articleUrl.replace("www.nytimes.com", "nytimes.com"),
    articleUrl.replace("https:", "http:"),
    articleUrl.replace("www.nytimes.com", "WWW.NYTIMES.COM"),
  ])("accepts the article URL %s", (url) => {
    expect(parseNytimesTarget(url)).toBe(url)
    expect(isNytimesUrl(url)).toBe(true)
    expect(planForUrl(url)).toMatchObject({
      pipelineName: "nytimes",
      contentType: "news_article",
      targetedLoaders: ["nytimes"],
      fallbackLoaders: [],
      executionPlan: ["nytimes"],
      contentContract: "source_required",
    })
  })

  it.each([
    "not-a-url",
    "https://www.nytimes.com/",
    "https://www.nytimes.com/section/us/politics",
    "https://www.nytimes.com/live/2026/11/06/us/politics",
    articleUrl.replace("https:", "ftp:"),
    articleUrl.replace("www.nytimes.com", "cooking.nytimes.com"),
    articleUrl.replace("www.nytimes.com", "www.nytimes.com.example.com"),
    articleUrl.replace("www.nytimes.com", "notnytimes.com"),
    articleUrl.replace("www.nytimes.com", "user:pass@www.nytimes.com"),
    articleUrl.replace("www.nytimes.com", "www.nytimes.com:8080"),
    articleUrl.replace(".html", ".pdf"),
  ])("rejects unsupported targets %s", (url) => {
    expect(isNytimesUrl(url)).toBe(false)
    expect(() => parseNytimesTarget(url)).toThrow(LoaderNotApplicableError)
    expect(planForUrl(url).pipelineName).not.toBe("nytimes")
  })

  it("registers a public news loader and exposes its plan", async () => {
    expect(availableLoaders()).toContain("nytimes")
    expect(getLoaderDef("nytimes")).toMatchObject({
      contentType: "news_article",
      requirements: [],
      cliVisible: true,
      resourceKind: "request",
    })
    expect(await createLoader("nytimes")).toMatchObject({
      source: "nytimes",
      loaderName: "NYTimesLoader",
    })
    expect(explainPlan(articleUrl)).toMatchObject({
      pipeline: "nytimes",
      execution_plan: ["nytimes"],
      content_type: "news_article",
      missing_requirements: [],
    })
  })
})

describe("New York Times extraction", () => {
  it.each([
    'section name="articleBody"',
    'div data-testid="article-body"',
    'div itemprop="articleBody"',
  ])("extracts article-specific markup (%s)", (attributes) => {
    const tag = attributes.split(" ")[0]
    const html = `<nav>Navigation</nav><article><header>Sharing controls</header>
      <${attributes}><p>Lead &amp; context.</p><h2>Details</h2><p>A <strong>key</strong> fact.</p>
      <aside>Related stories</aside><div role="complementary">Newsletter</div>
      <div id="ad-1">Advertising</div><div id="story-ad-1-wrapper">Advertising</div>
      <div data-testid="inline-message">Advertising</div>
      <div data-testid="recirculation">Recommended</div>
      <div id="gateway-content"><p>Subscribe</p></div>
      <script>hidden()</script><style>hidden {}</style><noscript>Tracking</noscript>
      <form>Sign in</form><button>Share</button><footer>Copyright</footer>
      </${tag}></article><footer>Site links</footer>`
    expect(extractNytimesArticleText(html, articleUrl, "NYTimesLoader")).toBe(
      "Lead & context.\n## Details\nA **key** fact.",
    )
  })

  it("prefers article markup to a shorter JSON-LD excerpt", () => {
    const html = `${articleHtml}<script type="application/ld+json">{"articleBody":"Excerpt"}</script>`
    expect(extractNytimesArticleText(html, articleUrl, "NYTimesLoader")).toBe("Article body.")
  })

  it("falls back to nonempty JSON-LD articleBody after missing or empty markup", () => {
    const metadata = JSON.stringify({
      "@graph": [{ "@type": "NewsArticle", articleBody: " Lead\n Body " }],
    })
    const html = `<section name="articleBody"><div id="gateway-content">Subscribe</div></section>
      <script type="application/ld+json">not json</script>
      <script type="application/ld+json">${metadata}</script>`
    expect(extractNytimesArticleText(html, articleUrl, "NYTimesLoader")).toBe("Lead\nBody")
  })

  it.each([
    "<html><body>Please enable JS and disable any ad blocker</body></html>",
    "<main><h1>Sign in</h1><p>Log in or subscribe.</p></main>",
    "<article><h1>Headline</h1><p>Navigation and sharing controls</p></article>",
    '<section name="articleBody"><script>noise()</script></section>',
    '<script type="application/ld+json">{"description":"An excerpt","articleBody":" "}</script>',
  ])("rejects shells without an article body", (html) => {
    expect(() => extractNytimesArticleText(html, articleUrl, "NYTimesLoader")).toThrow(
      LoaderContentError,
    )
  })
})

describe("New York Times transports", () => {
  it("uses the bounded HTTP transport first and records success", async () => {
    const fetch = vi.fn(async () => htmlResponse(articleHtml))
    const resources = resourcesWithFetch(fetch)
    const attempts: AttemptRecord[] = []
    await expect(
      withAttemptSink(attempts, () => new NytimesLoader({ resources }).load(articleUrl)),
    ).resolves.toBe("Article body.")
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      articleUrl,
      expect.objectContaining({ signal: expect.any(AbortSignal), redirect: "follow" }),
    )
    expect(attempts).toMatchObject([{ loaderId: "nytimes:httpx", status: "success" }])
    expect(fetchImpersHtml).not.toHaveBeenCalled()
    expect(resources.browser).not.toHaveBeenCalled()
  })

  it("tries impersonation when HTTP returns a challenge instead of an article", async () => {
    const resources = resourcesWithFetch(async () => htmlResponse("<main>Challenge</main>"))
    vi.mocked(fetchImpersHtml).mockResolvedValue({ content: articleHtml, contentType: "text/html" })
    const attempts: AttemptRecord[] = []
    await expect(
      withAttemptSink(attempts, () => new NytimesLoader({ resources }).load(articleUrl)),
    ).resolves.toBe("Article body.")
    expect(fetchImpersHtml).toHaveBeenCalledExactlyOnceWith(
      articleUrl,
      expect.objectContaining({ resources, loaderName: "NYTimesLoader" }),
    )
    expect(attempts).toMatchObject([
      { loaderId: "nytimes:httpx", status: "failed" },
      { loaderId: "nytimes:curl-cffi", status: "success" },
    ])
    expect(resources.browser).not.toHaveBeenCalled()
  })

  it("admits the bounded browser fallback separately", async () => {
    const resources = resourcesWithFetch(async () => new Response(null, { status: 403 }))
    vi.mocked(fetchBrowserHtmlResponse).mockResolvedValue({
      content: articleHtml,
      contentType: "text/html",
    })
    await expect(new NytimesLoader({ resources }).load(articleUrl)).resolves.toBe("Article body.")
    expect(resources.runBrowser).toHaveBeenCalledOnce()
    expect(fetchBrowserHtmlResponse).toHaveBeenCalledWith(
      articleUrl,
      expect.objectContaining({
        loaderName: "NYTimesLoader",
        timeoutMs: 30_000,
        waitUntil: "domcontentloaded",
        validateUrl: expect.any(Function),
        fetchUrl: expect.any(Function),
      }),
    )
  })

  it("rejects non-HTML responses even if their text contains article markup", async () => {
    const resources = resourcesWithFetch(
      async () => new Response(articleHtml, { headers: { "content-type": "application/json" } }),
    )
    await expect(new NytimesLoader({ resources }).load(articleUrl)).rejects.toThrow("Expected HTML")
  })

  it.each([true, false])("enforces HTTP byte limits (declared: %s)", async (declared) => {
    const cancel = vi.fn()
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          if (!declared) controller.enqueue(new Uint8Array(MAX_HTML_BYTES + 1))
        },
        cancel,
      }),
      {
        headers: {
          "content-type": "text/html",
          ...(declared ? { "content-length": String(MAX_HTML_BYTES + 1) } : {}),
        },
      },
    )
    const resources = resourcesWithFetch(async () => response)
    await expect(new NytimesLoader({ resources }).load(articleUrl)).rejects.toThrow(
      `${MAX_HTML_BYTES} byte limit`,
    )
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each([true, false])(
    "preserves cancellation without fallback (already aborted: %s)",
    async (alreadyAborted) => {
      const controller = new AbortController()
      const reason = new Error("Cancelled by caller")
      const fetch = vi.fn<FetchImplementation>(async (_input, init) => {
        controller.abort(reason)
        throw init?.signal?.reason
      })
      const resources = resourcesWithFetch(fetch)
      if (alreadyAborted) controller.abort(reason)
      await expect(
        new NytimesLoader({ resources }).load(articleUrl, controller.signal),
      ).rejects.toBe(reason)
      expect(fetch).toHaveBeenCalledTimes(alreadyAborted ? 0 : 1)
      expect(fetchImpersHtml).not.toHaveBeenCalled()
      expect(resources.browser).not.toHaveBeenCalled()
    },
  )

  it("rejects unsupported targets before making a request", async () => {
    const fetch = vi.fn()
    await expect(
      new NytimesLoader({ resources: resourcesWithFetch(fetch) }).load("https://www.nytimes.com/"),
    ).rejects.toBeInstanceOf(LoaderNotApplicableError)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("New York Times client integration", () => {
  it.each([false, true])(
    "returns news content through automatic and explicit planning (explicit: %s)",
    async (explicit) => {
      const fetchImplementation = vi.fn(async () => htmlResponse(articleHtml))
      await using client = new UrlContentClient({
        fetchImplementation,
        resolve: publicResolver,
      }).start()
      const result = await client.loadUrlDetailed(
        articleUrl,
        explicit ? { loaderNames: ["nytimes"] } : {},
      )
      expect(result).toMatchObject({
        content: "Article body.",
        contentType: "news_article",
        loaderId: "nytimes",
        downgraded: false,
        attempts: [
          { loaderId: "nytimes:httpx", status: "success" },
          { loaderId: "nytimes", status: "success" },
        ],
      })
      expect(fetchImplementation).toHaveBeenCalledOnce()
    },
  )

  it("does not return blocked HTML through a generic fallback", async () => {
    const fetchImplementation = vi.fn(async () => htmlResponse("<main>Please enable JS</main>"))
    await using client = new UrlContentClient({
      fetchImplementation,
      resolve: publicResolver,
    }).start()
    vi.spyOn(client, "browser").mockRejectedValue(new Error("Browser unavailable"))
    await expect(client.loadUrlDetailed(articleUrl)).rejects.toMatchObject({
      attempts: [
        { loaderId: "nytimes:httpx", status: "failed" },
        { loaderId: "nytimes:curl-cffi", status: "failed" },
        { loaderId: "nytimes:browser", status: "failed" },
        { loaderId: "nytimes", status: "failed" },
      ],
    })
    expect(fetchImplementation).toHaveBeenCalledOnce()
  })

  it.each(["http://127.0.0.1/private", "http://[::1]/private", "http://private.example/"])(
    "rejects unsafe article redirects to %s",
    async (location) => {
      const fetchImplementation = vi.fn(
        async () => new Response(null, { status: 302, headers: { location } }),
      )
      await using client = new UrlContentClient({
        fetchImplementation,
        resolve: async (host) =>
          host === "private.example" ? [{ address: "10.0.0.1", family: 4 }] : publicResolver(),
      }).start()
      vi.spyOn(client, "browser").mockRejectedValue(new Error("Browser unavailable"))
      await expect(client.loadUrlDetailed(articleUrl)).rejects.toThrow(/[Pp]rivate/)
      expect(fetchImplementation).toHaveBeenCalledOnce()
    },
  )
})
