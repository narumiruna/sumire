import { afterEach, describe, expect, it, vi } from "vitest"
import {
  LoaderContentError,
  LoaderNotApplicableError,
  LoaderTimeoutError,
  TargetHttpError,
} from "../src/core/errors.js"
import { assertPublicUrl, type FetchImplementation } from "../src/core/network.js"
import type { ResourceProvider } from "../src/core/resources.js"
import {
  availableLoaders,
  createLoader,
  explainPlan,
  getLoaderDef,
  isWallhopUrl,
  parseWallhopTarget,
  planForUrl,
  UrlContentClient,
} from "../src/index.js"
import {
  DEFAULT_WALLHOP_TIMEOUT_MS,
  extractWallhopArticleText,
  MAX_WALLHOP_BYTES,
  WallhopLoader,
} from "../src/loaders/wallhop.js"

const articleUrl =
  "https://www.nytimes.com/2026/11/06/us/politics/chinese-spy-agency-nvidia-jensen-huang.html"
const wallhopUrl = `https://wallhop.io/${articleUrl}`
const rawUrl = `https://wallhop.io/raw/${articleUrl}`
const publicResolver = async () => [{ address: "8.8.8.8", family: 4 }]
const resolve = async (host: string) =>
  host === "private.example" ? [{ address: "10.0.0.1", family: 4 }] : publicResolver()
const articleHtml = `<a class="source" href="${articleUrl}">Original source</a>
  <article><h1>Synthetic headline</h1><p class="meta">By Test Writer</p>
  <p class="print-source">${articleUrl}</p><div class="body">
  <p>First synthetic paragraph &amp; context.</p><p>A <strong>second</strong> paragraph.</p>
  </div></article>`
const htmlResponse = (body = articleHtml, contentType = "text/html; charset=utf-8") =>
  new Response(body, { headers: { "content-type": contentType } })
const validateUrl = async (input: string | URL, signal?: AbortSignal) =>
  (await assertPublicUrl(input, { resolve, signal })).url

function resourcesWithFetch(fetch: FetchImplementation): ResourceProvider {
  return { fetch, validateUrl } as ResourceProvider
}

function loaderWithFetch(fetch: FetchImplementation, timeoutMs?: number) {
  return new WallhopLoader({ resources: resourcesWithFetch(fetch), timeoutMs })
}

afterEach(() => {
  vi.useRealTimers()
})

describe("Wallhop targets and public registration", () => {
  it.each([
    wallhopUrl,
    rawUrl,
    `https://wallhop.io/api/${articleUrl}`,
    `http://wallhop.io/${articleUrl}`,
    `https://WALLHOP.IO./${articleUrl}`,
  ])("maps explicit links to HTTPS raw requests: %s", (url) => {
    expect(isWallhopUrl(url)).toBe(true)
    expect(parseWallhopTarget(url)).toEqual({ url, targetUrl: articleUrl, rawUrl })
    expect(planForUrl(url)).toEqual({
      pipelineName: "wallhop",
      contentType: "news_article",
      targetedLoaders: ["wallhop"],
      fallbackLoaders: [],
      executionPlan: ["wallhop"],
      contentContract: "source_required",
    })
  })

  it("preserves embedded queries and excludes the outer fragment", () => {
    const targetUrl = `${articleUrl}?share=one%2Ftwo&item=1&item=2&next=https%3A%2F%2Fexample.com`
    expect(parseWallhopTarget(`https://wallhop.io/api/${targetUrl}#reader`)).toEqual({
      url: `https://wallhop.io/api/${targetUrl}#reader`,
      targetUrl,
      rawUrl: `https://wallhop.io/raw/${targetUrl}`,
    })
  })

  it("registers a public request loader and exposes the strict plan", async () => {
    expect(availableLoaders()).toContain("wallhop")
    expect(getLoaderDef("wallhop")).toMatchObject({
      contentType: "news_article",
      requirements: [],
      cliVisible: true,
      resourceKind: "request",
    })
    expect(await createLoader("wallhop")).toBeInstanceOf(WallhopLoader)
    expect(explainPlan(wallhopUrl)).toMatchObject({
      pipeline: "wallhop",
      execution_plan: ["wallhop"],
      content_type: "news_article",
      missing_requirements: [],
    })
    expect(planForUrl(articleUrl)).toMatchObject({
      pipelineName: "nytimes",
      executionPlan: ["nytimes"],
      fallbackLoaders: [],
    })
  })

  it.each([articleUrl, "https://wallhop.io.example.com/https://example.com/story"])(
    "does not treat a direct or lookalike URL as Wallhop: %s",
    async (url) => {
      const fetch = vi.fn()
      expect(isWallhopUrl(url)).toBe(false)
      expect(() => parseWallhopTarget(url)).toThrow()
      await expect(loaderWithFetch(fetch).load(url)).rejects.toBeInstanceOf(
        LoaderNotApplicableError,
      )
      expect(fetch).not.toHaveBeenCalled()
    },
  )
})

describe("Wallhop extraction", () => {
  it("reads the reader layout and verifies source metadata outside the article", () => {
    const text = extractWallhopArticleText(
      `<nav>Site navigation</nav>${articleHtml}<footer>Site footer</footer>`,
      wallhopUrl,
      articleUrl,
    )
    expect(text).toContain("# Synthetic headline")
    expect(text).toContain("By Test Writer")
    expect(text).toContain("First synthetic paragraph & context.")
    expect(text).toContain("A **second** paragraph.")
    expect(text).not.toMatch(/Original source|Site navigation|Site footer/)
  })

  it.each([
    `<a class="source" href="${articleUrl}">Source</a>`,
    `<link rel="canonical" href="${articleUrl}">`,
    `<meta property="og:url" content="${rawUrl}">`,
  ])("accepts matching source metadata: %s", (metadata) => {
    expect(
      extractWallhopArticleText(
        `${metadata}<article><p>Plain prose.</p></article>`,
        wallhopUrl,
        articleUrl,
      ),
    ).toBe("Plain prose.")
  })

  it.each([
    '<a class="source" href="https://example.com/other">Source</a>',
    '<link rel="canonical" href="https://www.nytimes.com/other.html">',
    `<meta property="og:url" content="${articleUrl}?different=1">`,
    `<a class="source" href="https://user:pass@www.nytimes.com${new URL(articleUrl).pathname}">Source</a>`,
    '<a class="source" href="javascript:alert(1)">Source</a>',
  ])("rejects conflicting or invalid metadata even with article prose: %s", (metadata) => {
    expect(() =>
      extractWallhopArticleText(`${metadata}${articleHtml}`, wallhopUrl, articleUrl),
    ).toThrow("different article")
  })

  it("allows source metadata without the requested query", () => {
    expect(extractWallhopArticleText(articleHtml, wallhopUrl, `${articleUrl}?share=1`)).toContain(
      "First synthetic paragraph",
    )
  })

  it("accepts plain article paragraphs without metadata and removes controls", () => {
    expect(
      extractWallhopArticleText(
        "<article><p>Plain prose.</p><nav>Links</nav><aside>Related</aside><footer>Footer</footer><form>Login</form><button>Share</button><script>hidden()</script><style>hidden{}</style><noscript>Tracking</noscript><svg>Icon</svg></article>",
        wallhopUrl,
        articleUrl,
      ),
    ).toBe("Plain prose.")
  })

  it("uses JSON-LD body when article prose is absent and prefers article prose otherwise", () => {
    const metadata = `<script type="application/ld+json">${JSON.stringify({
      "@graph": [{ "@type": "NewsArticle", articleBody: " Synthetic lead\nSynthetic body " }],
    })}</script>`
    expect(extractWallhopArticleText(metadata, wallhopUrl, articleUrl)).toBe(
      "Synthetic lead\nSynthetic body",
    )
    expect(
      extractWallhopArticleText(
        `<article><p>Full prose.</p></article>${metadata}`,
        wallhopUrl,
        articleUrl,
      ),
    ).toBe("Full prose.")
  })

  it.each([
    "<main>Please enable JavaScript to continue</main>",
    "<article><h1>Headline only</h1></article>",
    `<article><p class="meta">By Test Writer</p><p class="print-source">${articleUrl}</p></article>`,
    '<article><div class="body"><script>challenge()</script></div></article>',
    '<script type="application/ld+json">{"articleBody":" "}</script>',
  ])("rejects HTTP-200 shells without prose: %s", (html) => {
    expect(() => extractWallhopArticleText(html, wallhopUrl, articleUrl)).toThrow(
      LoaderContentError,
    )
  })
})

describe("Wallhop transport bounds", () => {
  it.each(["text/html; charset=utf-8", "application/xhtml+xml"])(
    "validates the embedded target before the raw endpoint and accepts %s",
    async (contentType) => {
      const fetch = vi.fn(async () => htmlResponse(articleHtml, contentType))
      const resources = resourcesWithFetch(fetch)
      const validate = vi.spyOn(resources, "validateUrl")
      await expect(new WallhopLoader({ resources }).load(wallhopUrl)).resolves.toContain(
        "First synthetic paragraph",
      )
      expect(validate.mock.calls.map(([url]) => url)).toEqual([articleUrl, rawUrl])
      expect(validate.mock.invocationCallOrder[1]).toBeLessThan(
        fetch.mock.invocationCallOrder[0] ?? 0,
      )
      expect(fetch).toHaveBeenCalledExactlyOnceWith(
        rawUrl,
        expect.objectContaining({ redirect: "manual", signal: expect.any(AbortSignal) }),
      )
    },
  )

  it.each([403, 404, 429, 500])("reports HTTP %s and cancels its body", async (status) => {
    const cancel = vi.fn()
    const fetch = vi.fn(async () => new Response(new ReadableStream({ cancel }), { status }))
    await expect(loaderWithFetch(fetch).load(wallhopUrl)).rejects.toMatchObject({
      constructor: TargetHttpError,
      status,
    })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each(["text/plain", "application/json", "application/pdf", undefined])(
    "rejects non-HTML responses (%s) and cancels their bodies",
    async (contentType) => {
      const cancel = vi.fn()
      const fetch = async () =>
        new Response(new ReadableStream({ cancel }), {
          headers: contentType ? { "content-type": contentType } : {},
        })
      await expect(loaderWithFetch(fetch).load(wallhopUrl)).rejects.toThrow("Expected Wallhop HTML")
      expect(cancel).toHaveBeenCalledOnce()
    },
  )

  it.each([true, false])(
    "enforces declared and streamed byte limits (declared=%s)",
    async (declared) => {
      const cancel = vi.fn()
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            if (!declared) controller.enqueue(new Uint8Array(MAX_WALLHOP_BYTES + 1))
          },
          cancel,
        }),
        {
          headers: {
            "content-type": "text/html",
            ...(declared ? { "content-length": String(MAX_WALLHOP_BYTES + 1) } : {}),
          },
        },
      )
      await expect(loaderWithFetch(async () => response).load(wallhopUrl)).rejects.toThrow(
        `${MAX_WALLHOP_BYTES} byte limit`,
      )
      expect(cancel).toHaveBeenCalledOnce()
    },
  )

  it.each(["validation", "fetch", "body"])(
    "bounds stalled %s with default and custom timeouts",
    async (stage) => {
      vi.useFakeTimers()
      expect(DEFAULT_WALLHOP_TIMEOUT_MS).toBe(30_000)
      for (const timeoutMs of [undefined, 25]) {
        const cancel = vi.fn()
        const fetch = vi.fn<FetchImplementation>(async () =>
          stage === "fetch"
            ? new Promise<Response>(() => {})
            : new Response(new ReadableStream({ cancel }), {
                headers: { "content-type": "text/html" },
              }),
        )
        const resources = resourcesWithFetch(fetch)
        if (stage === "validation") resources.validateUrl = async () => new Promise(() => {})
        const loading = new WallhopLoader({ resources, timeoutMs }).load(wallhopUrl)
        const rejected = expect(loading).rejects.toBeInstanceOf(LoaderTimeoutError)
        await vi.advanceTimersByTimeAsync(timeoutMs ?? 30_000)
        await rejected
        if (stage === "validation") expect(fetch).not.toHaveBeenCalled()
        if (stage === "body") expect(cancel).toHaveBeenCalledOnce()
        expect(vi.getTimerCount()).toBe(0)
      }
    },
  )

  it.each(["already aborted", "validation", "fetch", "body"])(
    "preserves caller cancellation during %s",
    async (stage) => {
      let markStarted!: () => void
      const started = new Promise<void>((resolve) => {
        markStarted = resolve
      })
      const controller = new AbortController()
      const reason = new Error("Cancelled by caller")
      const cancel = vi.fn()
      const fetch = vi.fn<FetchImplementation>(async () => {
        if (stage === "fetch") {
          markStarted()
          return new Promise<Response>(() => {})
        }
        return new Response(
          new ReadableStream({ pull: markStarted, cancel }, { highWaterMark: 0 }),
          {
            headers: { "content-type": "text/html" },
          },
        )
      })
      const resources = resourcesWithFetch(fetch)
      if (stage === "validation") {
        resources.validateUrl = async () => {
          markStarted()
          return new Promise(() => {})
        }
      }
      if (stage === "already aborted") controller.abort(reason)
      const loading = new WallhopLoader({ resources }).load(wallhopUrl, controller.signal)
      const rejected = expect(loading).rejects.toBe(reason)
      if (stage !== "already aborted") await started
      controller.abort(reason)
      await rejected
      if (stage === "already aborted" || stage === "validation")
        expect(fetch).not.toHaveBeenCalled()
      if (stage === "body") expect(cancel).toHaveBeenCalledOnce()
    },
  )

  it.each(["validation", "fetch"])(
    "does not continue after cancelled %s finishes late",
    async (stage) => {
      vi.useFakeTimers()
      let finish!: () => void
      let markStarted!: () => void
      const started = new Promise<void>((resolve) => {
        markStarted = resolve
      })
      const cancel = vi.fn()
      const fetch = vi.fn<FetchImplementation>(
        async () =>
          new Promise<Response>((resolve) => {
            finish = () =>
              resolve(
                new Response(new ReadableStream({ cancel }), {
                  headers: { "content-type": "text/html" },
                }),
              )
            markStarted()
          }),
      )
      const resources = resourcesWithFetch(fetch)
      if (stage === "validation") {
        resources.validateUrl = async () =>
          new Promise<URL>((resolve) => {
            finish = () => resolve(new URL(articleUrl))
            markStarted()
          })
      }
      const controller = new AbortController()
      const reason = new Error("Cancelled before late completion")
      const loading = new WallhopLoader({ resources }).load(wallhopUrl, controller.signal)
      const rejected = expect(loading).rejects.toBe(reason)
      await started
      controller.abort(reason)
      await rejected
      finish()
      await vi.advanceTimersByTimeAsync(0)
      expect(fetch).toHaveBeenCalledTimes(stage === "fetch" ? 1 : 0)
      expect(cancel).toHaveBeenCalledTimes(stage === "fetch" ? 1 : 0)
      expect(vi.getTimerCount()).toBe(0)
    },
  )
})

const invalidLinks = [
  "https://wallhop.io/",
  "https://wallhop.io/raw/not-a-url",
  "https://wallhop.io/raw/not-a-url.pdf",
  "https://wallhop.io/api/https://",
  `ftp://wallhop.io/${articleUrl}`,
  `https://user:pass@wallhop.io/${articleUrl}`,
  `https://wallhop.io:8443/${articleUrl}`,
  "https://wallhop.io/https://user:pass@example.com/story",
  "https://wallhop.io/https://example.com\\story",
  "https://wallhop.io/file:///etc/passwd",
  "https://wallhop.io/https://wallhop.io/https://example.com/story",
  "https://wallhop.io/https://wallhop.io./raw/https://example.com/story",
  "https://wallhop.io/https://127.0.0.1/private",
  "https://wallhop.io/raw/https://[::1]/private",
  "https://wallhop.io/api/https://169.254.169.254/metadata",
  "https://wallhop.io/https://localhost/private",
  "https://wallhop.io/https://private.example/story",
]

describe("Wallhop client integration and redirect safety", () => {
  it.each([false, true])("loads only the raw reader (explicit=%s)", async (explicit) => {
    const fetchImplementation = vi.fn<FetchImplementation>(async (input) => {
      expect(String(input)).toBe(rawUrl)
      return htmlResponse()
    })
    await using client = new UrlContentClient({ fetchImplementation, resolve }).start()
    const browser = vi.spyOn(client, "browser")
    const impers = vi.spyOn(client, "impersSession")
    const result = await client.loadUrlDetailed(
      wallhopUrl,
      explicit ? { loaderNames: ["wallhop"] } : {},
    )
    expect(result).toMatchObject({
      content: expect.stringContaining("First synthetic paragraph"),
      contentType: "news_article",
      loaderId: "wallhop",
      downgraded: false,
      attempts: [{ loaderId: "wallhop", status: "success" }],
    })
    expect(fetchImplementation).toHaveBeenCalledOnce()
    expect(browser).not.toHaveBeenCalled()
    expect(impers).not.toHaveBeenCalled()
  })

  it.each(invalidLinks)(
    "strictly rejects unsafe or malformed links without a service request: %s",
    async (url) => {
      const fetchImplementation = vi.fn()
      await using client = new UrlContentClient({ fetchImplementation, resolve }).start()
      expect(planForUrl(url).executionPlan).toEqual(["wallhop"])
      await expect(client.loadUrlDetailed(url)).rejects.toThrow()
      expect(fetchImplementation).not.toHaveBeenCalled()
    },
  )

  it("applies the HTTPS-only policy to the embedded target before contacting Wallhop", async () => {
    const fetchImplementation = vi.fn()
    await using client = new UrlContentClient({
      fetchImplementation,
      resolve,
      allowedSchemes: new Set(["https"]),
    }).start()
    await expect(
      client.loadUrlDetailed(`https://wallhop.io/${articleUrl.replace("https:", "http:")}`),
    ).rejects.toThrow(/scheme.*http/)
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it.each([301, 302, 303, 307, 308])(
    "follows a validated relative redirect (%s)",
    async (status) => {
      const location = `/api/${articleUrl}`
      const fetchImplementation = vi.fn<FetchImplementation>(async (input) => {
        if (String(input) === rawUrl) return new Response(null, { status, headers: { location } })
        expect(String(input)).toBe(`https://wallhop.io${location}`)
        return htmlResponse()
      })
      await using client = new UrlContentClient({ fetchImplementation, resolve }).start()
      await expect(client.loadUrlDetailed(wallhopUrl)).resolves.toMatchObject({
        loaderId: "wallhop",
      })
      expect(fetchImplementation).toHaveBeenCalledTimes(2)
    },
  )

  it.each([
    "https://127.0.0.1/private",
    "https://[::1]/private",
    "https://private.example/story",
    "https://user:pass@example.com/story",
    "https://wallhop.io/raw/https://127.0.0.1/private",
    "https://wallhop.io/api/https://private.example/story",
    "https://wallhop.io/raw/https://user:pass@example.com/story",
    `https://wallhop.io/raw/${articleUrl}?changed=1`,
    "https://wallhop.io/raw/https://example.com/other",
  ])("rejects unsafe or changed redirect targets before a second request: %s", async (location) => {
    const fetchImplementation = vi.fn(
      async () => new Response(null, { status: 302, headers: { location } }),
    )
    await using client = new UrlContentClient({ fetchImplementation, resolve }).start()
    await expect(client.loadUrlDetailed(wallhopUrl)).rejects.toMatchObject({
      attempts: [{ loaderId: "wallhop", status: "failed" }],
    })
    expect(fetchImplementation).toHaveBeenCalledOnce()
  })

  it("limits redirect loops and cancels each redirect body", async () => {
    const cancel = vi.fn()
    const fetch = vi.fn(
      async () =>
        new Response(new ReadableStream({ cancel }), {
          status: 302,
          headers: { location: rawUrl },
        }),
    )
    await expect(loaderWithFetch(fetch).load(wallhopUrl)).rejects.toThrow("redirect limit")
    expect(fetch).toHaveBeenCalledTimes(6)
    expect(cancel).toHaveBeenCalledTimes(6)
  })

  it("rejects redirects without Location", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302 }))
    await expect(loaderWithFetch(fetch).load(wallhopUrl)).rejects.toThrow("no Location")
    expect(fetch).toHaveBeenCalledOnce()
  })

  it.each(["challenge", "HTTP error"])(
    "does not use generic fallbacks after %s",
    async (failure) => {
      const fetchImplementation = vi.fn(async () =>
        failure === "challenge"
          ? htmlResponse("<main>Enable JavaScript to continue</main>")
          : new Response(null, { status: 403 }),
      )
      await using client = new UrlContentClient({ fetchImplementation, resolve }).start()
      const browser = vi.spyOn(client, "browser")
      const impers = vi.spyOn(client, "impersSession")
      await expect(client.loadUrlDetailed(wallhopUrl)).rejects.toMatchObject({
        attempts: [{ loaderId: "wallhop", status: "failed" }],
      })
      expect(fetchImplementation).toHaveBeenCalledOnce()
      expect(browser).not.toHaveBeenCalled()
      expect(impers).not.toHaveBeenCalled()
    },
  )
})
