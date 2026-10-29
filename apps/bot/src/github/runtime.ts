import { createHash } from "node:crypto"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import {
  createGithubMentionClient,
  type GithubMention,
} from "@narumitw/sumire-github-notifications"
import type { RuntimeConfigReader } from "@narumitw/sumire-runtime-config"
import type { GitHubAuth } from "../admin/github-auth.js"
import type { AdminStore } from "../admin/store.js"
import type { Settings } from "../config/settings.js"
import type { Logger } from "../logging.js"
import {
  createGithubReplyGenerator,
  type GeneratedGithubReply,
  githubModelSelection,
} from "./generation.js"
import { GithubState } from "./state.js"

const overlapMs = 120_000
const maxPages = 10
const defaultPollSeconds = 60
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex")

type MentionClient = ReturnType<typeof createGithubMentionClient>
type GenerateReply = (
  mention: GithubMention,
  authorize: () => void,
  signal: AbortSignal,
) => Promise<GeneratedGithubReply | undefined>

export interface GithubWorkerOptions {
  directory: string
  store: Pick<AdminStore, "snapshot">
  runtime: Pick<RuntimeConfigReader, "readSecret">
  github: Pick<GitHubAuth, "resolveToken">
  modelRuntime: ModelRuntime
  logger: Pick<Logger, "warn">
  generate: GenerateReply
  client?: MentionClient
  now?: () => number
}

/** Sequential transport worker. The Harness, not this worker, owns model retries and resumes. */
export class GithubMentionWorker {
  readonly #state: GithubState
  readonly #controller = new AbortController()
  readonly #client: MentionClient
  readonly #now: () => number
  #loop: Promise<void> | undefined
  #active: Promise<number> | undefined
  #close: Promise<void> | undefined
  #authorize: (() => void) | undefined
  #pollSeconds = defaultPollSeconds

  constructor(private readonly options: GithubWorkerOptions) {
    this.#state = new GithubState(options.directory)
    this.#now = options.now ?? Date.now
    this.#client =
      options.client ??
      createGithubMentionClient({
        token: () => options.runtime.readSecret("GH_TOKEN"),
        allowedUsernames: () =>
          options.store.snapshot().policy.githubNotifications.allowedUsernames,
        authorize: () => {
          this.#enabled()
          this.#authorize?.()
        },
      })
  }

  #policy() {
    this.#controller.signal.throwIfAborted()
    const state = this.options.store.snapshot()
    if (
      state.status !== "applied" ||
      state.revision !== state.applied ||
      !state.policy.githubNotifications.allowedUsernames.length
    )
      throw new Error("GitHub mention responses are not enabled by applied policy")
    return state
  }

  #enabled() {
    const state = this.#policy()
    const token = this.options.runtime.readSecret("GH_TOKEN")
    if (!token) throw new Error("GitHub mention responses require applied GH_TOKEN")
    return { state, token }
  }

  start() {
    this.#loop ??= this.#run()
  }

  async #run() {
    while (!this.#controller.signal.aborted) {
      let seconds = this.#pollSeconds
      try {
        seconds = await this.poll()
      } catch {
        seconds = this.#pollSeconds
        if (!this.#controller.signal.aborted)
          this.options.logger.warn("GitHub mention polling failed; checkpoints are retained")
      }
      try {
        await delay(seconds * 1000, undefined, { signal: this.#controller.signal })
      } catch {
        break
      }
    }
  }

  /** Exposed for deterministic lifecycle tests; calls must not overlap. */
  poll(): Promise<number> {
    if (this.#active) return Promise.reject(new Error("GitHub poll is already active"))
    this.#active = this.#poll().finally(() => {
      this.#active = undefined
    })
    return this.#active
  }

  async #poll(): Promise<number> {
    // Disabled policy performs no GitHub requests, model turns, or external writes.
    let policy: ReturnType<GithubWorkerOptions["store"]["snapshot"]>
    try {
      policy = this.#policy()
    } catch {
      return defaultPollSeconds
    }
    await this.options.github.resolveToken(this.#controller.signal)
    const state = this.#policy()
    if (state.revision !== policy.revision || state.epoch !== policy.epoch)
      throw new Error("GitHub applied settings changed during credential resolution")
    const token = this.options.runtime.readSecret("GH_TOKEN")
    if (!token) return defaultPollSeconds
    const initial = { state, token }
    const fingerprint = tokenHash(token)
    const operation = new AbortController()
    const signal = AbortSignal.any([this.#controller.signal, operation.signal])
    const authorize = (mention?: GithubMention) => {
      signal.throwIfAborted()
      const current = this.#enabled()
      if (
        current.state.revision !== initial.state.revision ||
        current.state.epoch !== initial.state.epoch ||
        current.token !== initial.token
      )
        throw new Error("GitHub applied settings changed during polling")
      if (
        mention &&
        !current.state.policy.githubNotifications.allowedUsernames.some(
          (name) => name.toLowerCase() === mention.author.toLowerCase(),
        )
      )
        throw new Error("GitHub mention author is no longer allowed")
    }
    // AdminStore has no change stream. Interrupt in-flight work, as well as guarding each boundary.
    this.#authorize = authorize
    const guard = setInterval(() => {
      try {
        authorize()
      } catch {
        operation.abort()
      }
    }, 1000)
    let seconds = defaultPollSeconds
    try {
      const scanStarted = this.#now()
      const freshSince = new Date(scanStarted - overlapMs).toISOString()
      const tokenSince = this.#state.start(fingerprint, freshSince)
      const knownAccount = this.#state.account(fingerprint)
      let since = knownAccount ? (this.#state.since(knownAccount) ?? tokenSince) : tokenSince
      let progress = knownAccount ? this.#state.scan(knownAccount) : undefined
      let page = progress?.page ?? 1
      authorize()
      let result = await this.#client.scan({ since, page, perPage: 20 }, signal)
      let scanned = 1
      this.#pollSeconds = Math.max(defaultPollSeconds, result.pollIntervalSeconds)
      authorize()
      const account = result.account
      this.#state.bind(fingerprint, account.id)
      // A rotated token for the same account must retain its checkpoint and pending work.
      const savedSince = this.#state.since(account.id)
      progress = this.#state.scan(account.id)
      const savedPage = progress?.page ?? 1
      if ((savedSince ?? tokenSince) !== since || savedPage !== page) {
        since = savedSince ?? tokenSince
        page = savedPage
        result = await this.#client.scan({ since, page, perPage: 20 }, signal)
        scanned++
        authorize()
      }
      // Page offsets can move while polling is idle. Recheck the last complete page before resuming.
      if (progress && result.pageKey !== progress.pageKey) {
        page = 1
        result = await this.#client.scan({ since, page, perPage: 20 }, signal)
        scanned++
        authorize()
      }
      // Keep the original pass cutoff across page limits, failures, restart, and token rotation.
      const checkpoint = progress?.checkpoint ?? freshSince
      if (!savedSince) this.#state.checkpoint(account.id, since)
      let complete = false
      for (; ; page++) {
        authorize()
        if (result.account.id !== account.id) throw new Error("GitHub account changed during scan")
        if (result.skippedThreads > 0)
          this.options.logger.warn("GitHub source history exceeded 10 pages; thread was skipped")
        seconds = Math.max(seconds, result.pollIntervalSeconds)
        this.#pollSeconds = seconds
        for (const mention of result.mentions) {
          if (mention.account.id !== account.id) throw new Error("GitHub mention account mismatch")
          // Notification activity can include old source comments. Do not admit historical backlog.
          if (Date.parse(mention.source.updatedAt) < Date.parse(since)) continue
          const allowed = initial.state.policy.githubNotifications.allowedUsernames.some(
            (name) => name.toLowerCase() === mention.author.toLowerCase(),
          )
          if (!allowed) continue
          authorize(mention)
          this.#state.admit(mention)
        }
        if (!result.hasMore) {
          complete = true
          break
        }
        this.#state.progress(account.id, page, result.pageKey, checkpoint)
        if (scanned >= maxPages) break
        result = await this.#client.scan({ since, page: page + 1, perPage: 20 }, signal)
        scanned++
      }
      authorize()
      if (complete) this.#state.completeScan(account.id, checkpoint)
      else this.options.logger.warn("GitHub scan reached 10 pages; continuation is saved")

      for (const pending of this.#state.pending(account.id)) {
        const mention = pending.mention
        if (
          !this.options.store
            .snapshot()
            .policy.githubNotifications.allowedUsernames.some(
              (name) => name.toLowerCase() === mention.author.toLowerCase(),
            )
        )
          continue
        const admit = () => {
          authorize(mention)
          githubModelSelection(this.options.store.snapshot().policy, this.options.modelRuntime)
        }
        admit()
        let response = pending.response
        let responseModel = pending.model
        if (response === null) {
          const generated = await this.options.generate(mention, admit, signal)
          authorize(mention)
          if (!generated) {
            this.#state.finish(mention.key, "failed")
            this.options.logger.warn("GitHub reply generation ended without a response")
            continue
          }
          response = generated.text
          responseModel = generated.model
          this.#state.response(mention.key, response, responseModel)
        }
        const responseAllowed = () => {
          const policy = this.options.store.snapshot().policy
          return (
            responseModel &&
            policy.models.includes(responseModel) &&
            policy.defaults.models?.includes(responseModel) &&
            policy.providers.some(
              (provider) => provider.id === responseModel.split("/")[0] && provider.enabled,
            )
          )
        }
        if (!responseAllowed()) continue
        const deliver = () => {
          admit()
          if (!responseAllowed()) throw new Error("GitHub response model is no longer allowed")
        }
        deliver()
        const selected = githubModelSelection(
          this.options.store.snapshot().policy,
          this.options.modelRuntime,
        )
        if (!(await this.options.modelRuntime.checkAuth(selected.model.provider, { signal })))
          throw new Error("GitHub reply model authentication is unavailable")
        deliver()
        this.#authorize = deliver
        let receipt: Awaited<ReturnType<MentionClient["reply"]>>
        try {
          receipt = await this.#client.reply(mention, response, signal)
        } catch {
          deliver()
          this.options.logger.warn("GitHub reply delivery failed; saved response is retained")
          continue
        } finally {
          this.#authorize = authorize
        }
        authorize(mention)
        this.#state.finish(mention.key, receipt.status === "ignored" ? "ignored" : "sent")
      }
      return seconds
    } finally {
      clearInterval(guard)
      this.#authorize = undefined
    }
  }

  close(): Promise<void> {
    this.#close ??= (async () => {
      this.#controller.abort()
      try {
        await Promise.allSettled([this.#loop, this.#active])
      } finally {
        this.#state.close()
      }
    })()
    return this.#close
  }
}

export function startGithubMentionWorker(
  settings: Settings,
  logger: Logger,
  control: { store: AdminStore; runtime: RuntimeConfigReader; github: GitHubAuth },
  modelRuntime: ModelRuntime,
): GithubMentionWorker {
  const directory = path.join(settings.projectRoot, ".telegramagent", "github")
  const worker = new GithubMentionWorker({
    directory,
    logger,
    ...control,
    modelRuntime,
    generate: createGithubReplyGenerator({
      directory,
      settings,
      runtime: modelRuntime,
      policy: () => control.store.snapshot().policy,
    }),
  })
  worker.start()
  return worker
}
