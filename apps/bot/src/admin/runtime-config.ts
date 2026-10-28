import type { RuntimeConfigMutation, RuntimeConfigResponse } from "@narumitw/sumire-contracts"
import {
  GITHUB_NOTIFICATIONS_TOKEN,
  GITHUB_NOTIFICATIONS_USERS,
  parseAllowedUserIds,
} from "@narumitw/sumire-github-notifications"
import {
  RuntimeConfigError,
  type RuntimeConfigReader,
  RuntimeConfigStore,
} from "@narumitw/sumire-runtime-config"
import { z } from "zod"
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
      entries: this.values.listMetadata(),
    }
  }
  readSecret(name: string): string | undefined {
    const state = this.store.snapshot()
    if (state.status !== "applied" || state.revision !== state.applied) return undefined
    return this.values.readSecret(name)
  }
  readVariable(name: string): string | undefined {
    return this.values.readVariable(name)
  }
  save(name: string, input: RuntimeConfigMutation, actor: string): void {
    const data = mutationSchema.parse(input)
    if (name === GITHUB_NOTIFICATIONS_USERS) {
      if (data.kind !== "variable") throw new AdminError(400, "GitHub allowlist must be a variable")
      try {
        parseAllowedUserIds(data.value)
      } catch {
        throw new AdminError(
          400,
          "GitHub allowlist must be a JSON array of unique positive user IDs",
        )
      }
    }
    if (
      name === GITHUB_NOTIFICATIONS_TOKEN &&
      (data.kind !== "secret" || !/^[\x21-\x7e]+$/.test(data.value))
    )
      throw new AdminError(
        400,
        "GitHub notification token must be a nonempty secret without whitespace",
      )
    this.change(() =>
      this.store.save(
        this.store.snapshot().policy,
        data.revision,
        actor,
        `runtime-config.${data.kind}.set`,
        name,
        () => {
          const metadata = { revision: data.revision + 1, updatedAt: Date.now() }
          if (data.kind === "secret") this.values.setSecret(name, data.value, metadata)
          else this.values.setVariable(name, data.value, metadata)
        },
      ),
    )
  }
  remove(name: string, revision: number, actor: string): void {
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(revision)
    this.change(() =>
      this.store.save(
        this.store.snapshot().policy,
        revision,
        actor,
        "runtime-config.delete",
        name,
        () => this.values.delete(name),
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
  private change(action: () => unknown): void {
    try {
      action()
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
