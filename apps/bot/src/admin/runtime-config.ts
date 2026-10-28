import type { RuntimeConfigMutation, RuntimeConfigResponse } from "@narumitw/sumire-contracts"
import {
  RuntimeConfigError,
  type RuntimeConfigReader,
  RuntimeConfigStore,
} from "@narumitw/sumire-runtime-config"
import { z } from "zod"
import {
  type GitHubCredentials,
  type GitHubPair,
  type GitHubStored,
  githubAccessDigest,
  githubStateName,
  parseGitHubCredentials,
} from "./github-state.js"
import { AdminError, type AdminStore } from "./store.js"

const mutationSchema = z
  .object({
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    kind: z.enum(["secret", "variable"]),
    value: z.string(),
  })
  .strict()
const importName = "runtime-config"

/** Transport-neutral administration and applied-revision gate for trusted consumers. */
export class RuntimeConfigAdmin implements RuntimeConfigReader {
  readonly values: RuntimeConfigStore
  constructor(
    private readonly store: AdminStore,
    key?: string,
  ) {
    this.values = new RuntimeConfigStore(store.db, key)
  }
  snapshot(): RuntimeConfigResponse {
    const { revision, applied, status } = this.store.snapshot()
    return {
      revision,
      applied,
      status,
      secretStatus: this.values.secretStatus,
      entries: this.values.listMetadata().filter((entry) => entry.name !== githubStateName),
    }
  }
  readSecret(name: string): string | undefined {
    if (name === githubStateName) return undefined
    const state = this.store.snapshot()
    if (state.status !== "applied" || state.revision !== state.applied) return undefined
    if (name === "GH_TOKEN") {
      const stored = this.githubCredentials()
      if (stored.kind === "manual") return stored.token
      if (
        stored.kind === "oauth" &&
        !stored.state.attempt &&
        !stored.state.reconnectRequired &&
        (stored.state.expiresAt === undefined || stored.state.expiresAt > Date.now())
      )
        return stored.token
      return undefined
    }
    return this.values.readSecret(name)
  }
  readVariable(name: string): string | undefined {
    return name === githubStateName ? undefined : this.values.readVariable(name)
  }
  /** Trusted raw pair read. Consumers must enforce the applied-state gate before dispatch. */
  githubCredentials(): GitHubStored {
    const entries = this.values.listMetadata()
    const access = entries.find((entry) => entry.name === "GH_TOKEN")
    const companion = entries.find((entry) => entry.name === githubStateName)
    if (!access && !companion) return { kind: "none" }
    if (access?.kind !== "secret" || (companion && companion.kind !== "secret"))
      return { kind: "invalid" }
    const token = this.values.readSecret("GH_TOKEN")
    if (!token) return { kind: "invalid" }
    if (!companion) return { kind: "manual", token }
    const payload = this.values.readSecret(githubStateName)
    if (!payload) return { kind: "invalid" }
    let state: GitHubCredentials | undefined
    try {
      state = parseGitHubCredentials(JSON.parse(payload))
    } catch {
      return { kind: "invalid" }
    }
    if (!state || state.accessDigest !== githubAccessDigest(token)) return { kind: "invalid" }
    return { kind: "oauth", token, state }
  }
  saveGitHub(token: string, state: GitHubCredentials, revision: number, actor: string): void {
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(revision)
    this.change(() =>
      this.store.save(
        this.store.snapshot().policy,
        revision,
        actor,
        "github.connect",
        "GH_TOKEN",
        () => {
          const parsed = this.validateGitHubState(token, state)
          this.assertGitHubWritable()
          const metadata = { revision: revision + 1, updatedAt: Date.now() }
          this.values.setSecret("GH_TOKEN", token, metadata)
          this.values.setSecret(githubStateName, JSON.stringify(parsed), metadata)
        },
      ),
    )
  }
  /** Explicit reset removes either entry, including legacy name and kind collisions. */
  disconnectGitHub(revision: number, actor: string): void {
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(revision)
    this.change(() =>
      this.store.save(
        this.store.snapshot().policy,
        revision,
        actor,
        "github.disconnect",
        `GH_TOKEN,${githubStateName}`,
        () => {
          const entries = this.values
            .listMetadata()
            .filter((entry) => entry.name === "GH_TOKEN" || entry.name === githubStateName)
          if (!entries.length) throw new RuntimeConfigError("missing")
          for (const entry of entries) this.values.delete(entry.name)
        },
      ),
    )
  }
  /** Encrypted same-generation CAS; it never changes settings or applies global state. */
  rotateGitHub(
    expected: GitHubPair,
    token: string,
    state: GitHubCredentials,
    event: "started" | "completed" | "failed",
  ): boolean {
    return this.change(() => {
      this.store.db.exec("BEGIN IMMEDIATE")
      try {
        const current = this.githubCredentials()
        if (current.kind === "invalid" && this.values.secretStatus !== "ready")
          throw new RuntimeConfigError(this.values.secretStatus)
        const previous = parseGitHubCredentials(expected.state)
        if (
          current.kind !== "oauth" ||
          current.token !== expected.token ||
          !previous ||
          JSON.stringify(current.state) !== JSON.stringify(previous)
        ) {
          this.store.db.exec("ROLLBACK")
          return false
        }
        const next = this.validateGitHubState(token, state)
        const matches = (changes: Partial<GitHubCredentials>) =>
          JSON.stringify(parseGitHubCredentials({ ...current.state, ...changes })) ===
          JSON.stringify(next)
        const valid =
          event === "started"
            ? !current.state.attempt &&
              !current.state.reconnectRequired &&
              !!next.attempt &&
              token === current.token &&
              matches({ attempt: next.attempt })
            : event === "completed"
              ? !!current.state.attempt &&
                !next.attempt &&
                !next.reconnectRequired &&
                next.generation === current.state.generation &&
                next.rotation === current.state.rotation + 1 &&
                next.clientId === current.state.clientId &&
                next.account.id === current.state.account.id &&
                next.account.login === current.state.account.login
              : event === "failed" &&
                token === current.token &&
                matches({ attempt: undefined, reconnectRequired: true })
        if (!valid) throw new RuntimeConfigError("invalid")
        const access = this.values.listMetadata().find((entry) => entry.name === "GH_TOKEN")
        if (!access) throw new RuntimeConfigError("missing")
        const metadata = { revision: access.revision, updatedAt: Date.now() }
        this.values.setSecret("GH_TOKEN", token, metadata)
        this.values.setSecret(githubStateName, JSON.stringify(next), metadata)
        this.store.audit(
          "system",
          `github.refresh.${event}`,
          this.store.snapshot().revision,
          "saved",
          "GH_TOKEN",
        )
        this.store.db.exec("COMMIT")
        return true
      } catch (error) {
        this.store.db.exec("ROLLBACK")
        throw error
      }
    })
  }
  save(name: string, input: RuntimeConfigMutation, actor: string): void {
    this.assertPublicName(name)
    const data = mutationSchema.parse(input)
    this.change(() =>
      this.store.save(
        this.store.snapshot().policy,
        data.revision,
        actor,
        `runtime-config.${data.kind}.set`,
        name,
        () => {
          if (name === "GH_TOKEN" && this.hasGitHubState()) this.assertGitHubWritable()
          const metadata = { revision: data.revision + 1, updatedAt: Date.now() }
          if (data.kind === "secret") this.values.setSecret(name, data.value, metadata)
          else this.values.setVariable(name, data.value, metadata)
          if (name === "GH_TOKEN" && this.hasGitHubState()) this.values.delete(githubStateName)
        },
      ),
    )
  }
  remove(name: string, revision: number, actor: string): void {
    this.assertPublicName(name)
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(revision)
    this.change(() =>
      this.store.save(
        this.store.snapshot().policy,
        revision,
        actor,
        "runtime-config.delete",
        name,
        () => {
          if (name === "GH_TOKEN" && this.hasGitHubState()) this.assertGitHubWritable()
          this.values.delete(name)
          if (name === "GH_TOKEN" && this.hasGitHubState()) this.values.delete(githubStateName)
        },
      ),
    )
  }
  importLegacy(env: NodeJS.ProcessEnv): void {
    if (this.store.db.prepare("SELECT name FROM imports WHERE name=?").get(importName)) return
    // A canonical key is not sufficient: authenticate every existing envelope first.
    if (!this.values.verifySecrets()) return
    const state = this.store.snapshot()
    const existing = new Set(this.values.listMetadata().map((entry) => entry.name))
    const entries: [string, string][] = []
    let skipped = 0
    for (const name of ["FIRECRAWL_API_KEY", "MORSEL_API_KEY"]) {
      const value = env[name]
      if (!value || existing.has(name)) continue
      if (
        Buffer.byteLength(value) > 8192 ||
        Buffer.from(value).toString() !== value ||
        existing.size + entries.length >= 256
      ) {
        skipped++
        continue
      }
      entries.push([name, value])
    }
    this.change(() =>
      this.store.save(
        state.policy,
        state.revision,
        "system",
        "runtime-config.import",
        "runtime-config",
        () => {
          for (const [name, value] of entries)
            this.values.setSecret(name, value, {
              revision: state.revision + 1,
              updatedAt: Date.now(),
            })
          this.store.db
            .prepare("INSERT INTO imports VALUES (?,?)")
            .run(importName, JSON.stringify({ imported: entries.length, skipped }))
        },
      ),
    )
  }
  private hasGitHubState(): boolean {
    return this.values.listMetadata().some((entry) => entry.name === githubStateName)
  }
  private assertPublicName(name: string): void {
    if (name === githubStateName)
      throw new AdminError(
        400,
        "GitHub OAuth state is server-owned; use GitHub connection controls",
      )
  }
  private assertGitHubWritable(): void {
    if (this.githubCredentials().kind !== "invalid") return
    if (this.values.secretStatus !== "ready") throw new RuntimeConfigError(this.values.secretStatus)
    throw new AdminError(
      409,
      "GitHub credentials are invalid; explicitly disconnect GH_TOKEN and GITHUB_OAUTH_STATE before saving",
    )
  }
  private validateGitHubState(token: string, state: GitHubCredentials): GitHubCredentials {
    const parsed = parseGitHubCredentials(state)
    if (!parsed || typeof token !== "string" || parsed.accessDigest !== githubAccessDigest(token))
      throw new RuntimeConfigError("invalid")
    return parsed
  }
  private change<T>(action: () => T): T {
    try {
      return action()
    } catch (error) {
      if (!(error instanceof RuntimeConfigError)) throw error
      const status =
        error.code === "missing"
          ? 404
          : error.code === "kind"
            ? 409
            : error.code === "locked" || error.code === "unavailable"
              ? 503
              : 400
      throw new AdminError(status, error.message)
    }
  }
}
