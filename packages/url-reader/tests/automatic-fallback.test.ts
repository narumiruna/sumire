import { afterEach, describe, expect, it, vi } from "vitest"

import { FirecrawlApiHttpError, LoaderContentError, LoaderError } from "../src/core/errors.js"
import { withDeadline } from "../src/core/execution.js"
import { getInterruptedAttempts, runBounded } from "../src/core/interruption.js"
import { resolveExplicitLoadChain, resolveLoadChain } from "../src/load-chain.js"
import { planForUrl } from "../src/pipelines/catalog.js"

const url = "https://example.com/article"
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

function automatic(
  options: { firecrawlFallback?: boolean; succeed?: string; stall?: string } = {},
) {
  const signals: AbortSignal[] = []
  const built: string[] = []
  const chain = resolveLoadChain(url, {
    firecrawlFallback: options.firecrawlFallback,
    getFactory: (name) => () => {
      built.push(name)
      return {
        load: async (_url, signal) => {
          if (signal) signals.push(signal)
          if (name === options.stall) return new Promise<string>(() => {})
          if (name === options.succeed) return "verified article content"
          if (name === "firecrawl") throw new FirecrawlApiHttpError(url, 503)
          throw new LoaderContentError("CurlCffiLoader", url, "transport failed")
        },
      }
    },
  })
  return { chain, signals, built }
}

function fakeClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
}

describe("bounded automatic fallback", () => {
  it("reserves time for later alternatives instead of starving them at the shared deadline", async () => {
    fakeClock()
    const { chain, built, signals } = automatic({ stall: "curl-cffi", succeed: "playwright-fast" })
    const loading = withDeadline(performance.now() + 1_000, () => chain.loadDetailed())
    await vi.advanceTimersByTimeAsync(250)
    const result = await loading
    expect(built).toEqual(["curl-cffi", "playwright-fast"])
    expect(signals[0]?.aborted).toBe(true)
    expect(result.attempts).toMatchObject([
      { loaderId: "curl-cffi", status: "timeout", elapsedSeconds: 0.25 },
      { loaderId: "playwright-fast", status: "success" },
    ])
    expect(vi.getTimerCount()).toBe(0)
  })

  it("bounds stalled fast browser work and reaches the next method on the first request", async () => {
    fakeClock()
    const { chain, built } = automatic({ stall: "playwright-fast", succeed: "httpx" })
    const loading = withDeadline(performance.now() + 180_000, () => chain.loadDetailed())
    await vi.advanceTimersByTimeAsync(15_000)
    const result = await loading
    expect(built).toEqual(["curl-cffi", "playwright-fast", "httpx"])
    expect(result.attempts.map(({ status }) => status)).toEqual(["failed", "timeout", "success"])
    expect(result.loaderId).toBe("httpx")
  })

  it("reproduces starvation in an explicit chain without changing its exact-loader contract", async () => {
    fakeClock()
    const built: string[] = []
    const chain = resolveExplicitLoadChain(url, ["slow", "fast"], {
      getFactory: (name) => () => {
        built.push(name)
        return { load: async () => new Promise<string>(() => {}) }
      },
    })
    const failed = withDeadline(performance.now() + 30_000, () => chain.loadDetailed()).catch(
      (error) => error,
    )
    await vi.advanceTimersByTimeAsync(30_000)
    const error = await failed
    expect(error).toBeInstanceOf(LoaderError)
    expect(error.attempts).toMatchObject([{ loaderId: "slow", status: "timeout" }])
    expect(built).toEqual(["slow"])
  })

  it("caps automatic attempts even without a shared deadline", async () => {
    fakeClock()
    const { chain } = automatic({ stall: "curl-cffi", succeed: "playwright-fast" })
    const loading = chain.loadDetailed()
    await vi.advanceTimersByTimeAsync(20_000)
    expect((await loading).loaderId).toBe("playwright-fast")
  })

  it("preserves cancellation identity and attempts without starting another loader", async () => {
    fakeClock()
    const { chain, built, signals } = automatic({ stall: "curl-cffi" })
    const controller = new AbortController()
    const reason = new DOMException("private caller text", "AbortError")
    const loading = chain.loadDetailed(controller.signal).catch((error) => error)
    await vi.advanceTimersByTimeAsync(10)
    controller.abort(reason)
    expect(await loading).toBe(reason)
    expect(built).toEqual(["curl-cffi"])
    expect(signals[0]?.aborted).toBe(true)
    expect(getInterruptedAttempts(reason)).toMatchObject([
      { loaderId: "curl-cffi", status: "cancelled" },
    ])
    expect(JSON.stringify(getInterruptedAttempts(reason))).not.toContain("private caller text")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("keeps per-URL diagnostics separate when several loads share a cancellation reason", async () => {
    const controller = new AbortController()
    const entered = vi.fn()
    const urls = ["https://example.com/one", "https://example.com/two"]
    const names = ["httpx", "playwright-fast"]
    const loads = urls.map((target, index) =>
      resolveExplicitLoadChain(target, [names[index] ?? "httpx"], {
        getFactory: () => () => ({
          load: async () => {
            entered()
            return new Promise<string>(() => {})
          },
        }),
      })
        .loadDetailed(controller.signal)
        .catch((error) => error),
    )
    await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(2))
    const reason = new DOMException("cancelled", "AbortError")
    controller.abort(reason)
    expect(await Promise.all(loads)).toEqual([reason, reason])
    for (const [index, target] of urls.entries()) {
      expect(getInterruptedAttempts(reason, target)).toMatchObject([
        { loaderId: names[index], status: "cancelled" },
      ])
    }
  })

  it("records caller deadline expiry as timeout rather than retrying cancellation", async () => {
    const { chain, built } = automatic({ stall: "curl-cffi" })
    const controller = new AbortController()
    const loading = chain.loadDetailed(controller.signal).catch((error) => error)
    await vi.waitFor(() => expect(built).toHaveLength(1))
    const reason = new DOMException("deadline", "TimeoutError")
    controller.abort(reason)
    expect(await loading).toBe(reason)
    expect(getInterruptedAttempts(reason)).toMatchObject([{ status: "timeout" }])
    expect(built).toHaveLength(1)
  })

  it("requires explicit opt-in, keeps Firecrawl last, and preserves source-required plans", () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "test-key")
    expect(planForUrl(url).executionPlan).not.toContain("firecrawl")
    expect(planForUrl(url, { firecrawlFallback: true }).executionPlan.at(-1)).toBe("firecrawl")
    expect(
      planForUrl("https://docs.google.com/document/d/test/edit", { firecrawlFallback: true })
        .executionPlan,
    ).toEqual(["google-docs"])
  })

  it("skips the external fallback when its key is missing", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "")
    const { chain, built } = automatic({ firecrawlFallback: true })
    const error = await chain.loadDetailed().catch((error) => error)
    expect(error.attempts.at(-1)).toMatchObject({
      loaderId: "firecrawl",
      status: "skipped",
      errorType: "MissingRequirementError",
    })
    expect(built).not.toContain("firecrawl")
  })

  it("uses the opted-in external fallback only after local failures", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "test-key")
    const { chain, built } = automatic({ firecrawlFallback: true, succeed: "firecrawl" })
    expect((await chain.loadDetailed()).loaderId).toBe("firecrawl")
    expect(built).toEqual([
      "curl-cffi",
      "playwright-fast",
      "httpx",
      "playwright-networkidle",
      "firecrawl",
    ])
  })

  it("retains API status after all eligible loaders fail", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "test-key")
    const { chain } = automatic({ firecrawlFallback: true })
    const error = await chain.loadDetailed().catch((error) => error)
    expect(error.attempts.at(-1)).toMatchObject({
      loaderId: "firecrawl",
      status: "failed",
      errorCode: "firecrawl_api_http_503",
    })
  })

  it("does not start a paid request with less than one second remaining", async () => {
    fakeClock()
    vi.stubEnv("FIRECRAWL_API_KEY", "test-key")
    const { chain, built } = automatic({ firecrawlFallback: true })
    const error = await withDeadline(performance.now() + 500, () => chain.loadDetailed()).catch(
      (error) => error,
    )
    expect(built).not.toContain("firecrawl")
    expect(error.attempts.at(-1)).toMatchObject({ loaderId: "firecrawl", status: "skipped" })
  })

  it("removes bounded-operation timers and listeners on success and error", async () => {
    fakeClock()
    const controller = new AbortController()
    const removals: ReturnType<typeof vi.spyOn>[] = []
    await expect(
      runBounded(
        async (signal) => {
          removals.push(vi.spyOn(signal, "removeEventListener"))
          return "ok"
        },
        10,
        controller.signal,
      ),
    ).resolves.toBe("ok")
    await expect(
      runBounded(
        async (signal) => {
          removals.push(vi.spyOn(signal, "removeEventListener"))
          throw new Error("failed")
        },
        10,
        controller.signal,
      ),
    ).rejects.toThrow("failed")
    for (const remove of removals)
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })
})
