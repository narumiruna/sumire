import { randomUUID } from "node:crypto"
import type { GitHubConnection, GitHubFlow, GitHubReceipt } from "@narumitw/sumire-contracts"
import { GitHubClient, type GitHubToken, type GitHubTransport } from "../github-client.js"
import {
  type GitHubCredentials,
  type GitHubPair,
  githubAccessDigest,
  githubStateName,
} from "./github-state.js"
import type { RuntimeConfigAdmin } from "./runtime-config.js"
import { AdminError, type AdminStore, token } from "./store.js"

type Interaction = {
  id: string
  owner: string
  revision: number
  clientId: string
  status: GitHubFlow["status"]
  expiresAt: number
  controller: AbortController
  work: Promise<void>
  complete?: Promise<GitHubFlow>
  timer?: ReturnType<typeof setTimeout>
  watch?: ReturnType<typeof setInterval>
  retained?: ReturnType<typeof setTimeout>
  deviceCode?: string
  userCode?: string
  interval: number
  credential?: GitHubToken
  receivedAt?: number
  account?: GitHubCredentials["account"]
  scopes?: string[]
  error?: string
  receipt?: GitHubReceipt
  settled?: boolean
}
type Refresh = { promise: Promise<void>; controller: AbortController }
const active = (flow: Interaction) => flow.status === "pending" || flow.status === "authorized"
const reconnect = () => new AdminError(409, "Reconnect GitHub before using its managed credential.")
const projection = (state: ReturnType<AdminStore["snapshot"]>) => ({
  revision: state.revision,
  applied: state.applied,
  status: state.status,
})

/** GitHub capability lifecycle only. Pi retains model and tool scheduling ownership. */
export class GitHubAuth {
  private readonly flows = new Map<string, Interaction>()
  private readonly refreshing = new Map<string, Refresh>()
  private closed = false
  private apply?: () => Promise<void>
  private hasProbe = () => false

  constructor(
    private readonly store: AdminStore,
    private readonly runtime: RuntimeConfigAdmin,
    private readonly client: GitHubTransport = new GitHubClient(),
  ) {
    // Validate existing managed state without contacting GitHub or changing credentials.
    runtime.githubCredentials()
  }

  configure(apply: () => Promise<void>, hasProbe: () => boolean = () => false) {
    this.apply = apply
    this.hasProbe = hasProbe
  }

  connection(owner: string): GitHubConnection {
    this.prune()
    this.invalidate()
    const metadata = this.runtime.snapshot()
    const stored = this.runtime.githubCredentials()
    const clientId = this.runtime.readVariable("GITHUB_OAUTH_CLIENT_ID")
    const flow = [...this.flows.values()].reverse().find((value) => value.owner === owner)
    return {
      ...projection(this.store.snapshot()),
      secretStatus: metadata.secretStatus,
      ...(clientId && /^[A-Za-z0-9_.-]{1,128}$/.test(clientId) ? { clientId } : {}),
      mode: stored.kind,
      ...(stored.kind === "oauth"
        ? {
            account: { ...stored.state.account },
            scopes: [...stored.state.scopes],
            ...(stored.state.expiresAt === undefined ? {} : { expiresAt: stored.state.expiresAt }),
          }
        : {}),
      reconnectRequired:
        stored.kind === "invalid" ||
        (stored.kind === "oauth" &&
          Boolean(
            stored.state.reconnectRequired ||
              (stored.state.attempt && !this.refreshing.has(stored.state.generation)) ||
              (stored.state.refreshExpiresAt !== undefined &&
                stored.state.refreshExpiresAt <= Date.now()) ||
              (stored.state.expiresAt !== undefined &&
                (!stored.state.refreshToken || stored.state.refreshExpiresAt === undefined)),
          )),
      ...(flow ? { flow: this.public(flow) } : {}),
    }
  }

  async start(owner: string, revision: number, replace: boolean): Promise<GitHubFlow> {
    this.assertOpen()
    this.prune(true)
    if (this.flows.size >= 16) throw new AdminError(429, "Too many GitHub authorization outcomes")
    this.invalidate()
    this.assertReady(revision)
    const sessionDeadline = this.store.sessionDeadline(owner)
    if (!sessionDeadline) throw new AdminError(401, "Administrator session expired")
    if ([...this.flows.values()].some(active))
      throw new AdminError(409, "Another GitHub login is pending")
    const stored = this.runtime.githubCredentials()
    if (stored.kind === "invalid")
      throw new AdminError(409, "Reset the stored GitHub connection first")
    if (stored.kind !== "none" && !replace)
      throw new AdminError(409, "Confirm replacement of GH_TOKEN first")
    const slots = stored.kind === "none" ? 2 : stored.kind === "manual" ? 1 : 0
    if (this.runtime.values.listMetadata().length + slots > 256)
      throw new AdminError(400, "Free runtime storage entries before connecting GitHub")
    const clientId = this.runtime.readVariable("GITHUB_OAUTH_CLIENT_ID")
    if (!clientId || !/^[A-Za-z0-9_.-]{1,128}$/.test(clientId))
      throw new AdminError(409, "Configure a valid GitHub OAuth App Client ID first")
    const flow: Interaction = {
      id: token(),
      owner,
      revision,
      clientId,
      status: "pending",
      expiresAt: Math.min(Date.now() + 900_000, sessionDeadline),
      controller: new AbortController(),
      work: Promise.resolve(),
      interval: 5,
    }
    this.flows.set(flow.id, flow)
    this.arm(flow)
    flow.watch = setInterval(() => this.check(flow), 1000)
    flow.watch.unref()
    let prepared = () => {}
    const ready = new Promise<void>((resolve) => {
      prepared = resolve
    })
    flow.work = (async () => {
      const grant = await this.client.device(clientId, flow.controller.signal)
      if (!this.check(flow)) return
      flow.deviceCode = grant.deviceCode
      flow.userCode = grant.userCode
      flow.interval = grant.interval
      flow.expiresAt = Math.min(flow.expiresAt, Date.now() + grant.expiresIn * 1000)
      this.arm(flow)
      prepared()
      while (this.check(flow) && flow.status === "pending") {
        await this.sleep(flow.interval * 1000, flow.controller.signal)
        if (!this.check(flow)) return
        const result = await this.client.exchange(
          clientId,
          grant.deviceCode,
          flow.controller.signal,
        )
        if (!this.check(flow)) return
        if ("error" in result) {
          if (result.error === "authorization_pending") continue
          if (result.error === "slow_down") {
            flow.interval = Math.max(flow.interval + 5, result.interval ?? 0)
            continue
          }
          this.finish(
            flow,
            result.error === "expired_token" || result.error === "token_expired"
              ? "expired"
              : "failed",
            "GitHub authorization was denied or expired. Start a new login.",
          )
          return
        }
        const receivedAt = Date.now()
        const account = await this.client.account(result.accessToken, flow.controller.signal)
        if (!this.check(flow)) return
        flow.credential = result
        flow.receivedAt = receivedAt
        flow.account = account
        flow.scopes = [...result.scopes]
        flow.status = "authorized"
        flow.deviceCode = undefined
        flow.userCode = undefined
      }
    })()
      .catch(() => {
        if (active(flow))
          this.finish(flow, "failed", "GitHub authorization failed. Start a new login.")
      })
      .finally(prepared)
    await ready
    return this.public(flow)
  }

  state(id: string, owner: string): GitHubFlow {
    const flow = this.owned(id, owner)
    this.check(flow)
    return this.public(flow)
  }

  async complete(id: string, owner: string): Promise<GitHubFlow> {
    const flow = this.owned(id, owner)
    if (flow.complete) return flow.complete
    if (!this.check(flow)) return this.public(flow)
    if (flow.status !== "authorized" || !flow.credential || !flow.account)
      throw new AdminError(409, "GitHub authorization is not ready to save")
    this.assertReady(flow.revision)
    const credentials = flow.credential
    const state = this.credentialState(
      credentials,
      {
        version: 1,
        generation: randomUUID(),
        rotation: 0,
        clientId: flow.clientId,
        account: flow.account,
        scopes: credentials.scopes,
        accessDigest: githubAccessDigest(credentials.accessToken),
      },
      flow.receivedAt,
    )
    if (state.expiresAt !== undefined && state.expiresAt <= Date.now()) {
      this.finish(flow, "expired", "GitHub authorization expired. Start a new login.")
      return this.public(flow)
    }
    const before = this.store.snapshot()
    try {
      this.runtime.saveGitHub(
        credentials.accessToken,
        state,
        flow.revision,
        String(this.store.adminId),
      )
    } catch (error) {
      // A driver/read failure can follow COMMIT. Verify the exact generation before
      // classifying it as a failed write; never repeat persistence to find out.
      let committed = false
      try {
        const current = this.store.snapshot()
        const stored = this.runtime.githubCredentials()
        committed =
          !this.store.db.isTransaction &&
          current.revision === flow.revision + 1 &&
          stored.kind === "oauth" &&
          stored.state.generation === state.generation &&
          stored.token === credentials.accessToken
      } catch {
        /* An unavailable database leaves the outcome unverified. */
      }
      if (!committed) {
        this.finish(
          flow,
          error instanceof AdminError && error.status === 409 ? "conflict" : "failed",
          "GitHub save could not be verified. Reload safe metadata before another action.",
        )
        return this.public(flow)
      }
    }
    flow.receipt = {
      savedRevision: flow.revision + 1,
      application: { revision: flow.revision + 1, applied: before.applied, status: "pending" },
    }
    this.finish(flow, "completed")
    flow.complete = (async () => {
      let failed = false
      try {
        await this.apply?.()
      } catch {
        failed = true
      }
      if (flow.receipt) {
        try {
          let current = this.store.snapshot()
          if (
            failed &&
            current.revision === flow.receipt.savedRevision &&
            (current.status !== "applied" || current.applied !== current.revision)
          ) {
            this.store.applied(current.revision, false)
            current = this.store.snapshot()
          }
          flow.receipt.application =
            current.revision === flow.receipt.savedRevision
              ? projection(current)
              : { ...flow.receipt.application, status: "unknown" }
        } catch {
          // Persistence is known to have succeeded even when status reads fail.
          flow.receipt.application = { ...flow.receipt.application, status: "unknown" }
        }
      }
      flow.settled = true
      this.retain(flow)
      return this.public(flow)
    })()
    return flow.complete
  }

  async cancel(id: string, owner: string): Promise<GitHubFlow> {
    const flow = this.owned(id, owner)
    if (flow.complete) return flow.complete
    if (active(flow)) this.finish(flow, "cancelled")
    await flow.work
    return this.public(flow)
  }

  async cancelOwner(owner?: string): Promise<void> {
    const flows = [...this.flows.values()].filter((flow) => !owner || flow.owner === owner)
    for (const flow of flows) if (active(flow)) this.finish(flow, "cancelled")
    await Promise.all(flows.map((flow) => flow.complete ?? flow.work))
  }

  invalidate(): void {
    for (const flow of this.flows.values()) this.check(flow)
    const stored = this.runtime.githubCredentials()
    for (const [generation, refresh] of this.refreshing)
      if (stored.kind !== "oauth" || stored.state.generation !== generation)
        refresh.controller.abort()
  }

  async resolveToken(signal?: AbortSignal): Promise<string | undefined> {
    this.assertOpen()
    signal?.throwIfAborted()
    this.assertApplied()
    const stored = this.runtime.githubCredentials()
    if (stored.kind === "invalid") {
      const entries = this.runtime.values.listMetadata()
      const publicVariable = entries.some(
        (entry) => entry.name === "GH_TOKEN" && entry.kind === "variable",
      )
      const companion = entries.some((entry) => entry.name === githubStateName)
      // A public variable is data, not a broken credential. Managed pairs still fail closed.
      if (publicVariable && !companion) return undefined
      throw reconnect()
    }
    if (stored.kind === "none") return undefined
    if (stored.kind === "manual") return stored.token
    const state = stored.state
    let refresh = this.refreshing.get(state.generation)
    if (!refresh) {
      if (state.attempt || state.reconnectRequired) throw reconnect()
      if (
        state.expiresAt !== undefined &&
        (!state.refreshToken ||
          state.refreshExpiresAt === undefined ||
          state.refreshExpiresAt <= Date.now())
      ) {
        this.runtime.rotateGitHub(
          stored,
          stored.token,
          { ...state, reconnectRequired: true },
          "failed",
        )
        throw reconnect()
      }
      if (state.expiresAt === undefined || state.expiresAt - Date.now() >= 60_000)
        return stored.token
      const controller = new AbortController()
      const promise = this.rotate(stored, controller.signal)
      refresh = { promise, controller }
      this.refreshing.set(state.generation, refresh)
      void promise
        .finally(() => {
          if (this.refreshing.get(state.generation)?.promise === promise)
            this.refreshing.delete(state.generation)
        })
        .catch(() => {})
    }
    await this.wait(refresh.promise, signal)
    this.assertOpen()
    signal?.throwIfAborted()
    this.assertApplied()
    const latest = this.runtime.githubCredentials()
    if (
      latest.kind !== "oauth" ||
      latest.state.generation !== state.generation ||
      latest.state.attempt ||
      latest.state.reconnectRequired
    )
      throw reconnect()
    return latest.token
  }

  async close(): Promise<void> {
    this.closed = true
    for (const refresh of this.refreshing.values()) refresh.controller.abort()
    await Promise.all([
      this.cancelOwner(),
      ...[...this.refreshing.values()].map((value) => value.promise.catch(() => {})),
    ])
    for (const flow of this.flows.values()) if (flow.retained) clearTimeout(flow.retained)
    this.flows.clear()
  }

  private async rotate(pair: GitHubPair, signal: AbortSignal): Promise<void> {
    const attempted = { ...pair.state, attempt: randomUUID() }
    if (!this.runtime.rotateGitHub(pair, pair.token, attempted, "started")) throw reconnect()
    const expected = { token: pair.token, state: attempted }
    try {
      const result = await this.client.refresh(
        attempted.clientId,
        attempted.refreshToken ?? "",
        signal,
      )
      signal.throwIfAborted()
      const state = this.credentialState(result, { ...attempted, rotation: attempted.rotation + 1 })
      if (!this.runtime.rotateGitHub(expected, result.accessToken, state, "completed"))
        throw reconnect()
    } catch {
      try {
        this.runtime.rotateGitHub(
          expected,
          pair.token,
          { ...attempted, attempt: undefined, reconnectRequired: true },
          "failed",
        )
      } catch {
        /* The durable attempt marker still blocks reuse after storage failure. */
      }
      throw reconnect()
    }
  }

  private credentialState(
    value: GitHubToken,
    base: GitHubCredentials,
    receivedAt = Date.now(),
  ): GitHubCredentials {
    return {
      ...base,
      attempt: undefined,
      reconnectRequired: undefined,
      scopes: [...value.scopes],
      accessDigest: githubAccessDigest(value.accessToken),
      expiresAt: value.expiresIn === undefined ? undefined : receivedAt + value.expiresIn * 1000,
      refreshToken: value.refreshToken,
      refreshExpiresAt:
        value.refreshExpiresIn === undefined
          ? undefined
          : receivedAt + value.refreshExpiresIn * 1000,
    }
  }

  private public(flow: Interaction): GitHubFlow {
    return {
      id: flow.id,
      status: flow.status,
      expiresAt: flow.expiresAt,
      ...(flow.status === "pending" && flow.userCode
        ? { userCode: flow.userCode, verificationUri: "https://github.com/login/device" }
        : {}),
      ...(flow.account ? { account: { ...flow.account } } : {}),
      ...(flow.scopes ? { scopes: [...flow.scopes] } : {}),
      ...(flow.error ? { error: flow.error } : {}),
      ...(flow.receipt
        ? {
            receipt: {
              savedRevision: flow.receipt.savedRevision,
              application: { ...flow.receipt.application },
            },
          }
        : {}),
    }
  }

  private owned(id: string, owner: string): Interaction {
    this.prune()
    const flow = this.flows.get(id)
    if (!flow || flow.owner !== owner) throw new AdminError(404, "GitHub login not found")
    return flow
  }

  private assertOpen() {
    if (this.closed) throw new AdminError(503, "GitHub authentication is stopping")
  }

  private assertApplied() {
    const state = this.store.snapshot()
    if (state.status !== "applied" || state.applied !== state.revision)
      throw new AdminError(409, "Apply saved settings before using GitHub credentials")
  }

  private assertReady(revision: number) {
    this.assertOpen()
    this.assertApplied()
    if (!this.apply) throw new AdminError(503, "GitHub authentication is unavailable")
    if (revision !== this.store.snapshot().revision)
      throw new AdminError(409, "Settings changed; reload before GitHub login")
    if (!this.runtime.values.verifySecrets())
      throw new AdminError(503, "GitHub credential storage is locked or unavailable")
    if (this.hasProbe()) throw new AdminError(409, "Wait for the MCP connection test to finish")
  }

  private check(flow: Interaction): boolean {
    if (!active(flow)) return false
    if (this.closed || !this.store.sessionDeadline(flow.owner)) {
      this.finish(flow, "cancelled")
      return false
    }
    if (Date.now() >= flow.expiresAt) {
      this.finish(flow, "expired", "GitHub authorization expired. Start a new login.")
      return false
    }
    if (this.store.snapshot().revision !== flow.revision) {
      this.finish(
        flow,
        "conflict",
        "Settings changed. Start a new GitHub login after reloading metadata.",
      )
      return false
    }
    return true
  }

  private arm(flow: Interaction) {
    if (flow.timer) clearTimeout(flow.timer)
    flow.timer = setTimeout(
      () => this.finish(flow, "expired", "GitHub authorization expired. Start a new login."),
      Math.max(1, flow.expiresAt - Date.now()),
    )
    flow.timer.unref()
  }

  private finish(flow: Interaction, status: GitHubFlow["status"], error?: string) {
    if (!active(flow)) return
    flow.status = status
    flow.error = error
    flow.controller.abort()
    if (flow.timer) clearTimeout(flow.timer)
    if (flow.watch) clearInterval(flow.watch)
    flow.deviceCode = undefined
    flow.userCode = undefined
    flow.credential = undefined
    flow.receivedAt = undefined
    if (status !== "completed") {
      flow.settled = true
      this.retain(flow)
    }
  }

  private retain(flow: Interaction) {
    flow.retained = setTimeout(() => {
      if (this.flows.get(flow.id) === flow) this.flows.delete(flow.id)
    }, 300_000)
    flow.retained.unref()
  }

  private prune(reserve = false) {
    while (this.flows.size >= (reserve ? 16 : 17)) {
      const terminal = [...this.flows.values()].find((flow) => !active(flow) && flow.settled)
      if (!terminal) break
      if (terminal.retained) clearTimeout(terminal.retained)
      this.flows.delete(terminal.id)
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
        reject(new AdminError(409, "GitHub authorization was cancelled"))
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", abort)
        resolve()
      }, ms)
      timer.unref()
      signal.addEventListener("abort", abort, { once: true })
    })
  }

  private async wait(promise: Promise<void>, signal?: AbortSignal) {
    if (!signal) return promise
    signal.throwIfAborted()
    let abort = () => {}
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(new AdminError(409, "GitHub credential request was cancelled"))
      signal.addEventListener("abort", abort, { once: true })
    })
    try {
      await Promise.race([promise, cancelled])
    } finally {
      signal.removeEventListener("abort", abort)
    }
  }
}
