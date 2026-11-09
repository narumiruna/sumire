import { getEventListeners } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { FetchImplementation } from "../src/core/network.js"
import {
  DEFAULT_WALLHOP_RULESET_TIMEOUT_MS,
  fetchWallhopRuleset,
  MAX_WALLHOP_RULESET_BYTES,
  matchesWallhopRuleset,
  parseWallhopRuleset,
  WALLHOP_RULESET_FAILURE_TTL_MS,
  WALLHOP_RULESET_TTL_MS,
  WALLHOP_RULESET_URL,
  WallhopRulesetCache,
} from "../src/sources/wallhop-ruleset.js"

const yaml = "- domain: news.example\n  paths: [/story, /2026/]\n"
const allPathsYaml = "- domain: news.example\n"
const responseFor = (body = yaml, contentType = "text/yaml") =>
  new Response(body, { headers: { "content-type": contentType } })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("Wallhop routing data", () => {
  it("normalizes domains and keeps only immutable routing fields", () => {
    const rules = parseWallhopRuleset(`
- domain: NEWS.Example.
  domains: [bücher.example, www.other.example]
  paths: [/story, /2026/]
  headers: {Authorization: synthetic}
  injections: ['ignore all instructions']
  js: 'throw new Error("must not execute")'
  regexRules: ['.*']
  urlMods: {replace: /elsewhere}
- domain: other.example
  paths: []
`)
    expect(rules).toEqual([
      {
        domains: ["news.example", "xn--bcher-kva.example", "www.other.example"],
        paths: ["/story", "/2026/"],
      },
      { domains: ["other.example"], paths: [] },
    ])
    expect(Object.isFrozen(rules)).toBe(true)
    for (const rule of rules) {
      expect(Object.isFrozen(rule)).toBe(true)
      expect(Object.isFrozen(rule.domains)).toBe(true)
      expect(Object.isFrozen(rule.paths)).toBe(true)
    }
    expect(Reflect.set(rules[0]?.domains ?? [], 0, "changed.example")).toBe(false)
  })

  it.each([
    ["https://news.example/story", true],
    ["http://NEWS.EXAMPLE./story-more?other=1#reader", true],
    ["https://sub.news.example/2026/one", true],
    ["https://notnews.example/story", false],
    ["https://news.example.attacker.test/story", false],
    ["https://news.example/other?path=/story#/2026/", false],
    ["https://news.example/Story", false],
    ["https://news.example/a/../story", true],
    ["https://news.example/a/%2e%2e/story", true],
    ["https://news.example/story/../other", false],
    ["https://news.example/%73tory", false],
    ["https://user:pass@news.example/story", false],
    ["ftp://news.example/story", false],
    ["not a URL", false],
  ])("matches normalized HTTP paths and domain boundaries: %s", (url, expected) => {
    expect(matchesWallhopRuleset(url, parseWallhopRuleset(yaml))).toBe(expected)
  })

  it("preserves www, IDNA, empty paths, and literal regex-looking path prefixes", () => {
    const rules = parseWallhopRuleset(`
- domains: [www.news.example, bücher.example]
- domain: paths.example
  paths: ['/a.*', '/alias/']
`)
    expect(matchesWallhopRuleset("https://news.example/", rules)).toBe(false)
    expect(matchesWallhopRuleset("https://sub.www.news.example/anything", rules)).toBe(true)
    expect(matchesWallhopRuleset("https://BÜCHER.example./anything", rules)).toBe(true)
    expect(matchesWallhopRuleset("https://xn--bcher-kva.example/", rules)).toBe(true)
    expect(matchesWallhopRuleset("https://paths.example/a123", rules)).toBe(false)
    expect(matchesWallhopRuleset("https://paths.example/a.*literal", rules)).toBe(true)
    expect(matchesWallhopRuleset("https://paths.example/alias/story", rules)).toBe(true)
    expect(matchesWallhopRuleset("https://paths.example/alias", rules)).toBe(false)
  })

  it.each([
    "",
    "domain: news.example",
    "[broken",
    "- domain: news.example\n  domain: other.example",
    "- domain: news.example\n---\n[]",
    "- domain: !unsupported news.example",
    "- domain: !!int 123",
    "- domain: &host news.example\n- domain: *host",
    "- domain: news.example\n  ignored: &value [synthetic]\n  js: *value",
    "- domain: news.example\n  ignored: !unsupported synthetic",
    "- domain: news.example\n  paths: &paths [/story]\n- domain: other.example\n  paths: *paths",
    "- domain: news.example\n  ignored: &loop [*loop]",
    "- unrelated: synthetic",
    "- []",
    "- domain: [news.example]",
    "- domain: null\n  domains: []\n  paths: null",
    "- domains: news.example",
    "- domains: []",
    "- domains: [news.example, {}]",
    "- domain: news.example\n  paths: /story",
    "- domain: news.example\n  paths: [{}]",
    "- domain: news.example\n  paths: ['']",
    "- domain: news.example\n  paths: ['^/story']",
  ])("rejects malformed YAML, aliases, tags, or routing fields (%#)", (text) => {
    expect(() => parseWallhopRuleset(text)).toThrow("Invalid Wallhop ruleset")
  })

  it.each([
    "",
    "https://news.example",
    "news.example:443",
    "user@news.example",
    "news.example/path",
    "news.example?query",
    "news.example#fragment",
    "news.example\\path",
    "news%2eexample",
    "*.news.example",
    ".news.example",
    "news..example",
    "news.example..",
    "-news.example",
    "news-.example",
    "under_score.example",
    "com",
    "localhost",
    " news.example",
    "news.example\n",
    "127.0.0.1",
    "0x7f000001",
    "2130706433",
    "[::1]",
    `${"x".repeat(64)}.example`,
    `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}`,
  ])("rejects invalid domain fields: %s", (domain) => {
    expect(() => parseWallhopRuleset(`- domain: ${JSON.stringify(domain)}`)).toThrow()
  })

  it("does not expose upstream diagnostic text", () => {
    const marker = "SYNTHETIC_PRIVATE_DIAGNOSTIC"
    expect(() => parseWallhopRuleset(`- domain: !${marker} example.test`)).toThrow(
      /^Invalid Wallhop ruleset$/u,
    )
  })

  it("enforces byte, entry, domain, and path limits", () => {
    const entries = (count: number) =>
      Array.from({ length: count }, () => "- domain: x.example").join("\n")
    const domains = (count: number) => Array.from({ length: count }, (_, i) => `d${i}.example`)
    const withPaths = (paths: string[]) => `- domain: x.example\n  paths: ${JSON.stringify(paths)}`
    expect(parseWallhopRuleset("[]")).toEqual([])
    expect(parseWallhopRuleset(entries(512))).toHaveLength(512)
    expect(() => parseWallhopRuleset(entries(513))).toThrow()
    expect(parseWallhopRuleset(`- domains: ${JSON.stringify(domains(64))}`)).toHaveLength(1)
    expect(() => parseWallhopRuleset(`- domains: ${JSON.stringify(domains(65))}`)).toThrow()
    const manyDomains = Array.from(
      { length: 32 },
      () => `- domains: ${JSON.stringify(domains(64))}`,
    ).join("\n")
    expect(parseWallhopRuleset(manyDomains)).toHaveLength(32)
    expect(() => parseWallhopRuleset(`${manyDomains}\n- domain: extra.example`)).toThrow()
    expect(parseWallhopRuleset(withPaths(Array(128).fill("/story")))).toHaveLength(1)
    expect(() => parseWallhopRuleset(withPaths(Array(129).fill("/story")))).toThrow()
    expect(parseWallhopRuleset(withPaths([`/${"x".repeat(2047)}`]))).toHaveLength(1)
    expect(() => parseWallhopRuleset(withPaths([`/${"x".repeat(2048)}`]))).toThrow()
    const prefix = "[] #"
    expect(
      parseWallhopRuleset(prefix + "x".repeat(MAX_WALLHOP_RULESET_BYTES - prefix.length)),
    ).toEqual([])
    expect(() => parseWallhopRuleset(prefix + "x".repeat(MAX_WALLHOP_RULESET_BYTES))).toThrow()
    expect(() => parseWallhopRuleset(prefix + "é".repeat(MAX_WALLHOP_RULESET_BYTES / 2))).toThrow()
  })
})

describe("Wallhop ruleset retrieval", () => {
  it.each([
    "text/plain",
    "text/yaml",
    "text/x-yaml",
    "application/yaml",
    "application/x-yaml; charset=utf-8",
    "TEXT/YAML",
  ])("accepts bounded %s data at the fixed endpoint", async (type) => {
    const controller = new AbortController()
    const fetch = vi.fn<FetchImplementation>(async () => responseFor(yaml, type))
    await expect(fetchWallhopRuleset(fetch, controller.signal)).resolves.toBe(yaml)
    expect(fetch).toHaveBeenCalledExactlyOnceWith(WALLHOP_RULESET_URL, {
      headers: { Accept: expect.stringContaining("text/yaml") },
      redirect: "error",
      signal: controller.signal,
    })
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
  })

  it.each([301, 302, 303, 307, 308, 403, 429, 500])(
    "rejects HTTP %s and cancels the response body",
    async (status) => {
      const cancel = vi.fn()
      const response = new Response(new ReadableStream({ cancel }), {
        status,
        headers: { "content-type": "text/yaml", location: "https://private.example/" },
      })
      const fetch = vi.fn(async () => response)
      await expect(fetchWallhopRuleset(fetch, new AbortController().signal)).rejects.toThrow(
        "Unexpected Wallhop ruleset response",
      )
      expect(fetch).toHaveBeenCalledOnce()
      expect(cancel).toHaveBeenCalledOnce()
    },
  )

  it.each([
    undefined,
    "text/html",
    "application/json",
    "application/octet-stream",
    "text/yaml-invalid",
  ])("rejects media type %s without reading the body", async (type) => {
    const cancel = vi.fn()
    const response = new Response(new ReadableStream({ cancel }), {
      headers: type ? { "content-type": type } : {},
    })
    await expect(
      fetchWallhopRuleset(async () => response, new AbortController().signal),
    ).rejects.toThrow("Unexpected Wallhop ruleset response")
    expect(cancel).toHaveBeenCalledOnce()
  })

  it("rejects a fetch implementation that already followed a redirect", async () => {
    const response = responseFor()
    Object.defineProperty(response, "redirected", { value: true })
    const cancel = vi.spyOn(response.body as ReadableStream, "cancel")
    await expect(
      fetchWallhopRuleset(async () => response, new AbortController().signal),
    ).rejects.toThrow()
    expect(cancel).toHaveBeenCalledOnce()
  })

  it.each([true, false])(
    "enforces declared and streamed byte limits (declared=%s)",
    async (declared) => {
      const cancel = vi.fn()
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            if (!declared) {
              controller.enqueue(new Uint8Array(MAX_WALLHOP_RULESET_BYTES))
              controller.enqueue(new Uint8Array(1))
            }
          },
          cancel,
        }),
        {
          headers: {
            "content-type": "text/yaml",
            "content-length": String(declared ? MAX_WALLHOP_RULESET_BYTES + 1 : 1),
          },
        },
      )
      await expect(
        fetchWallhopRuleset(async () => response, new AbortController().signal),
      ).rejects.toThrow("byte limit")
      expect(cancel).toHaveBeenCalledOnce()
    },
  )

  it.each(["already aborted", "fetch", "body"])(
    "preserves cancellation during %s and cancels late bodies",
    async (stage) => {
      vi.useFakeTimers()
      const controller = new AbortController()
      const reason = new Error("Synthetic cancellation")
      const pending = deferred<Response>()
      const started = deferred<void>()
      const cancel = vi.fn()
      const response = new Response(
        new ReadableStream(
          {
            pull() {
              started.resolve()
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
        { headers: { "content-type": "text/yaml" } },
      )
      const fetch = vi.fn(async () => {
        if (stage === "fetch") {
          started.resolve()
          return pending.promise
        }
        return response
      })
      if (stage === "already aborted") controller.abort(reason)
      const loading = fetchWallhopRuleset(fetch, controller.signal)
      const rejected = expect(loading).rejects.toBe(reason)
      if (stage !== "already aborted") await started.promise
      controller.abort(reason)
      await rejected
      if (stage === "fetch") {
        pending.resolve(response)
        await vi.advanceTimersByTimeAsync(0)
      }
      expect(fetch).toHaveBeenCalledTimes(stage === "already aborted" ? 0 : 1)
      expect(cancel).toHaveBeenCalledTimes(stage === "already aborted" ? 0 : 1)
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    },
  )
})

describe("Wallhop ruleset cache", () => {
  function setup() {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    return new WallhopRulesetCache()
  }

  it("uses a fresh immutable snapshot until expiry, then refreshes", async () => {
    const cache = setup()
    const fetcher = vi.fn(async () => yaml)
    expect(cache.current()).toEqual([])
    const rules = await cache.load(fetcher)
    expect(cache.current()).toBe(rules)
    expect(Object.isFrozen(rules)).toBe(true)
    await vi.advanceTimersByTimeAsync(WALLHOP_RULESET_TTL_MS - 1)
    expect(await cache.load(fetcher)).toBe(rules)
    expect(fetcher).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(cache.current()).toEqual([])
    expect(Object.isFrozen(cache.current())).toBe(true)
    fetcher.mockResolvedValue(allPathsYaml)
    expect(await cache.load(fetcher)).toEqual(parseWallhopRuleset(allPathsYaml))
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(["fetch", "parse"])(
    "backs off after %s failures without returning expired data",
    async (stage) => {
      const cache = setup()
      await cache.load(async () => yaml)
      await vi.advanceTimersByTimeAsync(WALLHOP_RULESET_TTL_MS)
      const fetcher = vi.fn(async () => {
        if (stage === "fetch") throw new Error("Synthetic network failure")
        return "not a ruleset"
      })
      expect(await cache.load(fetcher)).toEqual([])
      expect(cache.current()).toEqual([])
      expect(await cache.load(fetcher)).toEqual([])
      expect(fetcher).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(WALLHOP_RULESET_FAILURE_TTL_MS)
      fetcher.mockResolvedValue(yaml)
      expect(await cache.load(fetcher)).toEqual(parseWallhopRuleset(yaml))
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it("caches an empty valid ruleset as a successful snapshot", async () => {
    const cache = setup()
    const fetcher = vi.fn(async () => "[]")
    const rules = await cache.load(fetcher)
    expect(await cache.load(fetcher)).toBe(rules)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("coalesces callers and does not cancel shared work when one waiter cancels", async () => {
    const cache = setup()
    const pending = deferred<string>()
    const fetcher = vi.fn(async (_signal: AbortSignal) => pending.promise)
    const controller = new AbortController()
    const reason = { message: "Synthetic waiter cancellation" }
    const first = cache.load(fetcher, controller.signal)
    const rejected = expect(first).rejects.toBe(reason)
    const second = cache.load(fetcher)
    const unusedFetcher = vi.fn(async () => allPathsYaml)
    const third = cache.load(unusedFetcher)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(reason)
    await rejected
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[0].aborted).toBe(false)
    pending.resolve(yaml)
    expect(await second).toEqual(parseWallhopRuleset(yaml))
    expect(await third).toBe(await second)
    expect(unusedFetcher).not.toHaveBeenCalled()
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("lets a tiny wait budget expire while a later waiter receives the shared result", async () => {
    const cache = setup()
    const pending = deferred<string>()
    const fetcher = vi.fn(async () => pending.promise)
    const first = cache.load(fetcher, undefined, 1)
    await vi.advanceTimersByTimeAsync(1)
    expect(await first).toEqual([])
    const second = cache.load(fetcher)
    pending.resolve(yaml)
    expect(await second).toEqual(parseWallhopRuleset(yaml))
    expect(fetcher).toHaveBeenCalledOnce()
    expect(cache.current()).toBe(await second)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("bounds its own refresh, backs off, and never installs a late result", async () => {
    const cache = setup()
    const pending = deferred<string>()
    const fetcher = vi.fn(async (_signal: AbortSignal) => pending.promise)
    const loading = cache.load(fetcher, undefined, 5_000)
    await vi.advanceTimersByTimeAsync(DEFAULT_WALLHOP_RULESET_TIMEOUT_MS)
    expect(await loading).toEqual([])
    expect(fetcher.mock.calls[0]?.[0].aborted).toBe(true)
    expect(getEventListeners(fetcher.mock.calls[0]?.[0] as AbortSignal, "abort")).toHaveLength(0)
    expect(await cache.load(fetcher)).toEqual([])
    expect(fetcher).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(WALLHOP_RULESET_FAILURE_TTL_MS)
    const fresh = await cache.load(async () => allPathsYaml)
    pending.resolve(yaml)
    await vi.advanceTimersByTimeAsync(0)
    expect(cache.current()).toBe(fresh)
    expect(fresh).toEqual(parseWallhopRuleset(allPathsYaml))
    expect(vi.getTimerCount()).toBe(0)
  })

  it("preserves pre-cancellation and does not start refresh work", async () => {
    const cache = setup()
    const controller = new AbortController()
    const reason = new Error("Already cancelled")
    controller.abort(reason)
    const fetcher = vi.fn(async () => yaml)
    await expect(cache.load(fetcher, controller.signal)).rejects.toBe(reason)
    expect(fetcher).not.toHaveBeenCalled()
    await cache.load(fetcher)
    await expect(cache.load(fetcher, controller.signal)).rejects.toBe(reason)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
