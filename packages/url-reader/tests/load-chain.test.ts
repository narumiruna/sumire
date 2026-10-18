import { afterEach, describe, expect, it, vi } from "vitest"

import {
  FailureDiagnosticError,
  FirecrawlApiHttpError,
  LoaderContentError,
  LoaderError,
  LoaderNotApplicableError,
  LoaderTimeoutError,
  MissingRequirementError,
  TargetHttpError,
} from "../src/core/errors.js"
import { withDeadline } from "../src/core/execution.js"
import { getInterruptedAttempts } from "../src/core/interruption.js"
import type { Loader } from "../src/core/loader.js"
import { AttemptStatus } from "../src/core/results.js"
import {
  explainLoadChain,
  LoadChain,
  LoadChainExplanation,
  resolveExplicitLoadChain,
} from "../src/load-chain.js"
import { ContentContract, ContentType } from "../src/pipelines/catalog.js"

const originalKey = process.env.FIRECRAWL_API_KEY
afterEach(() => {
  if (originalKey === undefined) delete process.env.FIRECRAWL_API_KEY
  else process.env.FIRECRAWL_API_KEY = originalKey
})

class SuccessLoader implements Loader {
  async load(url: string): Promise<string> {
    return `loaded ${url}`
  }
}

class EmptyLoader implements Loader {
  async load(): Promise<string> {
    return ""
  }
}

class NotApplicableLoader implements Loader {
  async load(url: string): Promise<string> {
    throw new LoaderNotApplicableError("NotApplicableLoader", url, "unsupported domain")
  }
}

class TimeoutLoader implements Loader {
  async load(url: string): Promise<string> {
    throw new LoaderTimeoutError("TimeoutLoader", url, 3)
  }
}

class ContentFailLoader implements Loader {
  async load(url: string): Promise<string> {
    throw new LoaderContentError("ContentFailLoader", url, "parse failed")
  }
}

const factories = {
  success: () => new SuccessLoader(),
  empty: () => new EmptyLoader(),
  "not-applicable": () => new NotApplicableLoader(),
  timeout: () => new TimeoutLoader(),
  "content-fail": () => new ContentFailLoader(),
}

describe("load chain", () => {
  it("explains plans without constructing loaders", () => {
    expect(
      explainLoadChain("https://www.youtube.com/watch?v=dQw4w9WgXcQ").toObject(),
    ).toMatchObject({
      pipeline: "youtube",
      content_type: "youtube_video",
      execution_plan: ["youtube", "youtube-ytdlp"],
      missing_requirements: [],
    })
  })

  it("runs custom loaders lazily and records empty attempts", async () => {
    const built: string[] = []
    const chain = resolveExplicitLoadChain("https://example.com", ["empty", "success", "unused"], {
      getFactory: (name) => () => {
        built.push(name)
        if (name === "empty") return new EmptyLoader()
        if (name === "success") return new SuccessLoader()
        throw new Error("must not construct")
      },
    })
    const result = await chain.loadDetailed()
    expect(result.content).toBe("loaded https://example.com")
    expect(result.attempts.map((attempt) => attempt.status)).toEqual([
      AttemptStatus.Empty,
      AttemptStatus.Success,
    ])
    expect(built).toEqual(["empty", "success"])
  })

  it("reports typed failures in attempt order", async () => {
    const names = ["not-applicable", "timeout", "content-fail", "empty"]
    const chain = resolveExplicitLoadChain("https://example.com", names, {
      getFactory: (name) => factories[name as keyof typeof factories],
    })
    const error = await chain.load().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LoaderError)
    expect((error as LoaderError).details).toEqual([
      "not-applicable: Not applicable (unsupported domain)",
      "timeout: Timeout after 3s",
      "content-fail: Content extraction failed - parse failed",
      "empty: Empty result",
    ])
  })

  it("classifies API status and typed TLS failures without copying error messages into attempts", async () => {
    const url = "https://example.com/private?key=secret"
    const chain = resolveExplicitLoadChain(url, ["firecrawl", "httpx", "curl-cffi"], {
      getFactory: (name) => () => ({
        load: async () => {
          if (name === "firecrawl") throw new FirecrawlApiHttpError(url, 403)
          if (name === "httpx") throw new TargetHttpError("HttpLoader", url, 403)
          const cause = Object.assign(new Error("private certificate path"), {
            name: "CertificateVerifyError",
          })
          throw new LoaderContentError("CurlCffiLoader", url, "TLS failed", undefined, cause)
        },
      }),
      getRequirements: () => [],
    })
    const error = await chain.loadDetailed().catch((caught: unknown) => caught as LoaderError)
    expect(error.attempts).toMatchObject([
      {
        loaderId: "firecrawl",
        status: "failed",
        errorType: "FirecrawlApiHttpError",
        errorCode: "firecrawl_api_http_403",
        diagnostic: { code: "service_http_error", phase: "loading", httpStatus: 403 },
      },
      {
        loaderId: "httpx",
        status: "failed",
        errorType: "TargetHttpError",
        errorCode: "target_http_403",
        diagnostic: { code: "target_http_error", phase: "loading", httpStatus: 403 },
      },
      {
        loaderId: "curl-cffi",
        status: "failed",
        errorType: "LoaderContentError",
        errorCode: "tls_certificate",
        diagnostic: { code: "tls_certificate", phase: "loading" },
      },
    ])
    expect(error.attempts.some((attempt) => attempt.message?.includes("private"))).toBe(false)
  })

  it("skips unavailable alternatives but fails early when none are eligible", async () => {
    delete process.env.FIRECRAWL_API_KEY
    const chain = resolveExplicitLoadChain("https://example.com", ["firecrawl", "success"], {
      getFactory: (name) => factories[name === "success" ? "success" : "empty"],
      getRequirements: (name) => (name === "firecrawl" ? ["FIRECRAWL_API_KEY"] : []),
    })
    const result = await chain.loadDetailed()
    expect(result.attempts.map((attempt) => attempt.status)).toEqual([
      AttemptStatus.Skipped,
      AttemptStatus.Success,
    ])

    expect(() =>
      resolveExplicitLoadChain("https://example.com", ["firecrawl"], {
        getFactory: () => () => new SuccessLoader(),
        getRequirements: () => ["FIRECRAWL_API_KEY"],
      }),
    ).toThrow(MissingRequirementError)
  })

  it("preserves caption and confirmed fallback facts before a configuration skip", async () => {
    delete process.env.FIRECRAWL_API_KEY
    const chain = resolveExplicitLoadChain(
      "https://example.com",
      ["youtube", "youtube-ytdlp", "firecrawl"],
      {
        getFactory: (name) => () => ({
          load: async (url) => {
            throw new FailureDiagnosticError(
              name,
              url,
              name === "youtube"
                ? { code: "captions_unavailable", phase: "captions" }
                : { code: "media_duration_limit", phase: "metadata", limit: 3600, observed: 5198 },
            )
          },
        }),
        getRequirements: (name) => (name === "firecrawl" ? ["FIRECRAWL_API_KEY"] : []),
      },
    )
    const error = await chain.loadDetailed().catch((caught: unknown) => caught as LoaderError)
    expect(error.attempts).toMatchObject([
      { loaderId: "youtube", diagnostic: { code: "captions_unavailable", phase: "captions" } },
      {
        loaderId: "youtube-ytdlp",
        diagnostic: {
          code: "media_duration_limit",
          phase: "metadata",
          limit: 3600,
          observed: 5198,
        },
      },
      { loaderId: "firecrawl", status: "skipped", diagnostic: { code: "configuration_missing" } },
    ])
  })

  it.each([false, true])(
    "retains ordered interrupted attempts without changing the reason (deadline: %s)",
    async (deadline) => {
      const controller = new AbortController()
      const reason = deadline
        ? new DOMException("private deadline details", "TimeoutError")
        : new Error("private cancellation details")
      let started = false
      const chain = resolveExplicitLoadChain(
        "https://example.com",
        ["youtube", "youtube-ytdlp", "unused"],
        {
          getFactory: (name) => () => ({
            load: async (url) => {
              if (name === "youtube")
                throw new FailureDiagnosticError(name, url, {
                  code: "captions_unavailable",
                  phase: "captions",
                })
              started = true
              return new Promise<string>(() => undefined)
            },
          }),
        },
      )
      const loading = chain.loadDetailed(controller.signal)
      await vi.waitFor(() => expect(started).toBe(true))
      controller.abort(reason)
      await expect(loading).rejects.toBe(reason)
      const attempts = getInterruptedAttempts(reason, "https://example.com")
      expect(attempts).toMatchObject([
        { loaderId: "youtube", diagnostic: { code: "captions_unavailable", phase: "captions" } },
        {
          loaderId: "youtube-ytdlp",
          status: deadline ? "timeout" : "cancelled",
          diagnostic: { code: deadline ? "deadline_exceeded" : "cancelled", phase: "loading" },
        },
      ])
      expect(JSON.stringify(attempts)).not.toContain("private")
    },
  )

  it("records a deadline reached before construction without inventing caption evidence", async () => {
    const chain = resolveExplicitLoadChain("https://example.com", ["youtube", "youtube-ytdlp"], {
      getFactory: () => () => {
        throw new Error("must not construct")
      },
    })
    const error = await withDeadline(performance.now() - 1, () => chain.loadDetailed()).catch(
      (caught: unknown) => caught as LoaderError,
    )
    expect(error.attempts).toMatchObject([
      {
        loaderId: "youtube",
        status: "timeout",
        diagnostic: { code: "deadline_exceeded", phase: "loading" },
      },
    ])
    expect(error.attempts).toHaveLength(1)
  })

  it("stops after a shared deadline", async () => {
    class WaitingLoader implements Loader {
      async load(_url: string, signal?: AbortSignal): Promise<string> {
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
          if (!signal) resolve()
        })
        return "late"
      }
    }
    const built: string[] = []
    const chain = resolveExplicitLoadChain("https://example.com", ["waiting", "success"], {
      getFactory: (name) => () => {
        built.push(name)
        return name === "waiting" ? new WaitingLoader() : new SuccessLoader()
      },
    })
    await expect(withDeadline(performance.now() + 10, () => chain.load())).rejects.toBeInstanceOf(
      LoaderError,
    )
    expect(built).toEqual(["waiting"])
  })

  it("races caller cancellation without a shared deadline", async () => {
    class IgnoringLoader implements Loader {
      async load(): Promise<string> {
        return new Promise(() => undefined)
      }
    }
    const chain = resolveExplicitLoadChain("https://example.com", ["ignoring"], {
      getFactory: () => () => new IgnoringLoader(),
    })
    const controller = new AbortController()
    const reason = new Error("cancelled by caller")
    const loading = chain.load(controller.signal)
    controller.abort(reason)
    await expect(loading).rejects.toBe(reason)
  })

  it("rejects a generic result for a source-required contract", async () => {
    const explanation = new LoadChainExplanation(
      "https://x.com/user/status/1",
      "twitter",
      ContentType.SocialPost,
      ["generic"],
      [],
      ["generic"],
      [],
      [],
      ["generic"],
      [],
      ContentContract.SourceRequired,
    )
    const chain = new LoadChain({
      getFactory: () => () => new SuccessLoader(),
      explanation,
      getRequirements: () => [],
      getContentType: () => ContentType.GenericWeb,
    })
    await expect(chain.load()).rejects.toThrow("Rejected content type")
  })
})
