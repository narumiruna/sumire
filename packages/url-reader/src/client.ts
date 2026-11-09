import { isIP } from "node:net"
import type { Browser } from "playwright"

import { remainingMilliseconds, withDeadline } from "./core/execution.js"
import {
  type FirecrawlCredentialOptions,
  resolveFirecrawlApiKey,
} from "./core/firecrawl-credentials.js"
import { runBounded } from "./core/interruption.js"
import {
  assertPublicUrl,
  type FetchImplementation,
  type PublicUrlResolver,
  safeFetch,
} from "./core/network.js"
import { type PublicProxy, startPublicProxy } from "./core/public-proxy.js"
import type { ImpersSession, ResourceProvider } from "./core/resources.js"
import type { LoadResult } from "./core/results.js"
import { resolveExplicitLoadChain, resolveLoadChain } from "./load-chain.js"
import {
  createLoader,
  getLoaderContentType,
  getLoaderDef,
  getLoaderRequirements,
} from "./loader-registry.js"
import { ContentType, planForUrl } from "./pipelines/catalog.js"
import { isPdfTarget, isWallhopUrl } from "./sources/applicability.js"
import {
  DEFAULT_WALLHOP_RULESET_TIMEOUT_MS,
  fetchWallhopRuleset,
  sharedWallhopRuleset,
  type WallhopRuleset,
  type WallhopRulesetProvider,
} from "./sources/wallhop-ruleset.js"

const CLIENT_CONTEXT_REQUIRED = "Call UrlContentClient.start() before loading URLs"
const INVALID_TARGET = "Target must be an HTTP(S) URL or a local PDF path"

class Semaphore {
  private available: number
  private readonly waiters: Array<{
    resolve: () => void
    reject: (reason: unknown) => void
    signal?: AbortSignal
    onAbort?: () => void
  }> = []

  constructor(limit: number) {
    this.available = limit
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason
    if (this.available > 0) {
      this.available -= 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: (typeof this.waiters)[number] = {
        resolve,
        reject,
        ...(signal ? { signal } : {}),
      }
      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index >= 0) this.waiters.splice(index, 1)
          reject(signal.reason)
        }
        signal.addEventListener("abort", waiter.onAbort, { once: true })
      }
      this.waiters.push(waiter)
    })
  }

  release(): void {
    const waiter = this.waiters.shift()
    if (!waiter) {
      this.available += 1
      return
    }
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort)
    waiter.resolve()
  }

  async use<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal)
    try {
      return await operation()
    } finally {
      this.release()
    }
  }
}

export interface UrlContentClientOptions extends FirecrawlCredentialOptions {
  allowedSchemes?: ReadonlySet<string>
  deadlineSeconds?: number
  requestLimit?: number
  browserLimit?: number
  workerLimit?: number
  fetchImplementation?: FetchImplementation
  resolve?: PublicUrlResolver
  wallhopRuleset?: WallhopRulesetProvider
}

export interface UrlContentLoadOptions extends FirecrawlCredentialOptions {
  firecrawlFallback?: boolean
  loaderNames?: readonly string[]
  signal?: AbortSignal
}

export class UrlContentClient implements ResourceProvider, AsyncDisposable {
  readonly deadlineSeconds?: number
  private readonly requestSlots: Semaphore
  private readonly browserSlots: Semaphore
  private readonly workerSlots: Semaphore
  private readonly fetchImplementation?: FetchImplementation
  private readonly resolve?: PublicUrlResolver
  private readonly allowedSchemes: ReadonlySet<string>
  private readonly firecrawlApiKey?: string | null
  private readonly wallhopRuleset: WallhopRulesetProvider
  private active = false
  private impersPromise?: Promise<ImpersSession>
  private proxyPromise?: Promise<PublicProxy>
  private browserPromise?: Promise<Browser>

  constructor(options: UrlContentClientOptions = {}) {
    if (options.deadlineSeconds !== undefined && options.deadlineSeconds <= 0) {
      throw new RangeError("deadlineSeconds must be positive")
    }
    const requestLimit = options.requestLimit ?? 8
    const browserLimit = options.browserLimit ?? 2
    const workerLimit = options.workerLimit ?? 2
    if ([requestLimit, browserLimit, workerLimit].some((value) => value <= 0)) {
      throw new RangeError("concurrency limits must be positive")
    }
    this.firecrawlApiKey = options.firecrawlApiKey
    this.wallhopRuleset = options.wallhopRuleset ?? sharedWallhopRuleset
    this.deadlineSeconds = options.deadlineSeconds
    this.requestSlots = new Semaphore(requestLimit)
    this.browserSlots = new Semaphore(browserLimit)
    this.workerSlots = new Semaphore(workerLimit)
    this.fetchImplementation = options.fetchImplementation
    this.resolve = options.resolve
    this.allowedSchemes = new Set(options.allowedSchemes ?? ["http", "https"])
  }

  start(): this {
    this.active = true
    return this
  }

  private checkActive(): void {
    if (!this.active) throw new Error(CLIENT_CONTEXT_REQUIRED)
  }

  async validateUrl(input: string | URL, signal?: AbortSignal): Promise<URL> {
    this.checkActive()
    return (
      await assertPublicUrl(input, {
        allowedSchemes: this.allowedSchemes,
        resolve: this.resolve,
        signal,
      })
    ).url
  }

  fetch(input: string | URL, init?: RequestInit): Promise<Response> {
    this.checkActive()
    return safeFetch(input, init, {
      ...(this.fetchImplementation ? { fetchImplementation: this.fetchImplementation } : {}),
      allowedSchemes: this.allowedSchemes,
      resolve: this.resolve,
      signal: init?.signal ?? undefined,
    })
  }

  async impersSession(): Promise<ImpersSession> {
    this.checkActive()
    if (!this.impersPromise) {
      this.impersPromise = import("impers").then(
        ({ Session }) => new Session({ impersonate: "chrome" }),
      )
    }
    return this.impersPromise
  }

  async impersProxy(): Promise<string> {
    this.checkActive()
    if (!this.proxyPromise)
      this.proxyPromise = startPublicProxy({
        allowedSchemes: this.allowedSchemes,
        resolve: this.resolve,
      })
    return (await this.proxyPromise).url
  }

  async browser(): Promise<Browser> {
    this.checkActive()
    if (!this.browserPromise) {
      this.browserPromise = import("playwright")
        .then(({ chromium }) => chromium.launch({ headless: true }))
        .catch((error: unknown) => {
          this.browserPromise = undefined
          throw error
        })
    }
    return this.browserPromise
  }

  runBrowser<T>(operation: () => Promise<T>): Promise<T> {
    return this.browserSlots.use(operation, admissionSignal())
  }

  runWorker<T>(operation: () => Promise<T>): Promise<T> {
    return this.workerSlots.use(operation, admissionSignal())
  }

  private admit(
    loaderName: string,
    operation: () => Promise<string>,
    signal?: AbortSignal,
  ): Promise<string> {
    const kind = getLoaderDef(loaderName).resourceKind
    const slots =
      kind === "browser"
        ? this.browserSlots
        : kind === "worker"
          ? this.workerSlots
          : this.requestSlots
    return slots.use(operation, signal ?? admissionSignal())
  }

  async loadUrlDetailed(url: string, signal?: AbortSignal): Promise<LoadResult>
  async loadUrlDetailed(url: string, options?: UrlContentLoadOptions): Promise<LoadResult>
  async loadUrlDetailed(
    url: string,
    optionsOrSignal?: AbortSignal | UrlContentLoadOptions,
  ): Promise<LoadResult> {
    return this.loadUrlDetailedWithOptions(url, normalizeLoadOptions(optionsOrSignal))
  }

  async loadUrl(url: string, signal?: AbortSignal): Promise<string>
  async loadUrl(url: string, options?: UrlContentLoadOptions): Promise<string>
  async loadUrl(
    url: string,
    optionsOrSignal?: AbortSignal | UrlContentLoadOptions,
  ): Promise<string> {
    return (await this.loadUrlDetailedWithOptions(url, normalizeLoadOptions(optionsOrSignal)))
      .content
  }

  private async loadUrlDetailedWithOptions(
    url: string,
    options: UrlContentLoadOptions,
  ): Promise<LoadResult> {
    this.checkActive()
    const firecrawlApiKey = resolveFirecrawlApiKey(
      options.firecrawlApiKey === undefined ? this.firecrawlApiKey : options.firecrawlApiKey,
    )
    const chainOptions = {
      firecrawlApiKey,
      getFactory: (name: string) => () => createLoader(name, this, { firecrawlApiKey }),
      getRequirements: getLoaderRequirements,
      getContentType: getLoaderContentType,
      admit: (name: string, operation: () => Promise<string>, signal?: AbortSignal) =>
        this.admit(name, operation, signal),
    }
    const explicitChain =
      options.loaderNames === undefined
        ? undefined
        : resolveExplicitLoadChain(url, options.loaderNames, chainOptions)
    const deadlineAt =
      this.deadlineSeconds === undefined
        ? undefined
        : performance.now() + this.deadlineSeconds * 1_000
    return withDeadline(deadlineAt, async () => {
      const timeoutSignal = admissionSignal()
      const validationSignal =
        options.signal && timeoutSignal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : (options.signal ?? timeoutSignal)
      await validateTarget(url, this.allowedSchemes, this.resolve, validationSignal)
      validationSignal?.throwIfAborted()
      const wallhopRules = explicitChain
        ? []
        : await this.prepareWallhopRules(url, validationSignal)
      const chain =
        explicitChain ??
        resolveLoadChain(url, {
          ...chainOptions,
          firecrawlFallback: options.firecrawlFallback,
          wallhopRules,
        })
      return chain.loadDetailed(options.signal)
    })
  }

  private async prepareWallhopRules(url: string, signal?: AbortSignal): Promise<WallhopRuleset> {
    const base = planForUrl(url, { wallhopRules: [] })
    if (
      !this.allowedSchemes.has("https") ||
      isWallhopUrl(url) ||
      (base.contentType !== ContentType.GenericWeb &&
        base.contentType !== ContentType.NewsArticle) ||
      isIP(new URL(url).hostname.replace(/^\[|\]$/gu, "")) !== 0
    ) {
      return []
    }
    const remaining = remainingMilliseconds()
    const waitMs = Math.min(
      DEFAULT_WALLHOP_RULESET_TIMEOUT_MS,
      remaining === undefined ? Infinity : remaining / 4,
    )
    if (waitMs <= 0) return []
    try {
      return await runBounded(
        () =>
          this.wallhopRuleset.load(
            // The shared metadata request must not hold a content-loader slot.
            (activeSignal) => fetchWallhopRuleset(this.fetch.bind(this), activeSignal),
            signal,
            waitMs,
          ),
        waitMs,
        signal,
      )
    } catch {
      signal?.throwIfAborted()
      return []
    }
  }

  async close(): Promise<void> {
    if (!this.active) return
    const [browser, impers, proxy] = await Promise.all([
      this.browserPromise?.catch(() => undefined),
      this.impersPromise?.catch(() => undefined),
      this.proxyPromise?.catch(() => undefined),
    ])
    this.browserPromise = undefined
    this.impersPromise = undefined
    this.proxyPromise = undefined
    this.active = false
    const errors: unknown[] = []
    if (browser) {
      try {
        await browser.close()
      } catch (error) {
        errors.push(error)
      }
    }
    if (impers) {
      try {
        await impers.close()
      } catch (error) {
        errors.push(error)
      }
    }
    if (proxy) {
      try {
        await proxy.close()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) throw errors[0]
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }
}

function normalizeLoadOptions(
  optionsOrSignal?: AbortSignal | UrlContentLoadOptions,
): UrlContentLoadOptions {
  if (!optionsOrSignal) return {}
  return optionsOrSignal instanceof AbortSignal ? { signal: optionsOrSignal } : optionsOrSignal
}

function admissionSignal(): AbortSignal | undefined {
  const remaining = remainingMilliseconds()
  return remaining === undefined
    ? undefined
    : AbortSignal.timeout(Math.max(1, Math.ceil(remaining)))
}

async function validateTarget(
  target: string,
  allowedSchemes: ReadonlySet<string>,
  resolve?: PublicUrlResolver,
  signal?: AbortSignal,
): Promise<void> {
  let isRemote = false
  try {
    isRemote = ["http:", "https:"].includes(new URL(target).protocol)
  } catch {
    // Non-URL PDF targets are handled as local paths.
  }
  if (isPdfTarget(target) && !isRemote) return
  try {
    await assertPublicUrl(target, { allowedSchemes, resolve, signal })
  } catch (error) {
    if (error instanceof TypeError && error.message === "URL is invalid")
      throw new TypeError(INVALID_TARGET)
    throw error
  }
}
