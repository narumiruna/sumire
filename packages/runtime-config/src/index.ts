import type { DatabaseSync } from "node:sqlite"
import { decrypt, encrypt, parseKey } from "./crypto.js"

export interface RuntimeConfigReader {
  readSecret(name: string): string | undefined
  readVariable(name: string): string | undefined
}
export type RuntimeConfigMetadata = { revision: number; updatedAt: number }
export type RuntimeConfigEntry = RuntimeConfigMetadata &
  (
    | { name: string; kind: "secret"; configured: true }
    | { name: string; kind: "variable"; value: string }
  )
export type RuntimeConfigErrorCode =
  | "invalid"
  | "limit"
  | "kind"
  | "unavailable"
  | "locked"
  | "missing"
const messages: Record<RuntimeConfigErrorCode, string> = {
  invalid: "Invalid runtime configuration name, value, or metadata",
  limit: "Runtime configuration supports at most 256 entries",
  kind: "Delete the entry before changing its kind",
  unavailable: "Secret storage is unavailable; repair the host key configuration",
  locked: "Secret storage is locked; restore the matching host key and database",
  missing: "Runtime configuration entry not found",
}
export class RuntimeConfigError extends Error {
  constructor(readonly code: RuntimeConfigErrorCode) {
    super(messages[code])
  }
}

export function initializeRuntimeConfigStorage(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS runtime_config (
    name TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('secret','variable')),
    payload TEXT NOT NULL,
    updatedAt INTEGER NOT NULL,
    revision INTEGER NOT NULL
  )`)
}

export function validateRuntimeConfigName(name: string): void {
  if (
    typeof name !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,127}$/.test(name) ||
    /^(BOT_TOKEN|BOT_ADMIN_ID|LOGFIRE_TOKEN|SUMIRE_SECRETS_KEY)$/.test(name) ||
    name.startsWith("ADMIN_")
  )
    throw new RuntimeConfigError("invalid")
}

type Row = RuntimeConfigMetadata & { name: string; kind: "secret" | "variable"; payload: string }

/** Uses the caller's connection and transaction. Never reads or modifies the environment. */
export class RuntimeConfigStore implements RuntimeConfigReader {
  private readonly key: Buffer | undefined
  private availability: "ready" | "unavailable" | "locked"
  constructor(
    private readonly db: DatabaseSync,
    key?: string,
  ) {
    this.key = parseKey(key)
    this.availability = this.key ? "ready" : "unavailable"
    if (this.key) this.verifySecrets()
  }
  get secretStatus() {
    return this.availability
  }
  /** Recheck all ciphertext before any secret write or import. Failure locks this instance. */
  verifySecrets(): boolean {
    if (this.availability !== "ready" || !this.key) return false
    try {
      const rows = this.db
        .prepare("SELECT name,payload FROM runtime_config WHERE kind='secret'")
        .all() as { name: string; payload: string }[]
      for (const row of rows) decrypt(this.key, row.name, row.payload)
      return true
    } catch {
      this.availability = "locked"
      return false
    }
  }
  listMetadata(): RuntimeConfigEntry[] {
    const rows = this.db.prepare("SELECT * FROM runtime_config ORDER BY name").all() as Row[]
    return rows.map(({ name, kind, payload, updatedAt, revision }) =>
      kind === "secret"
        ? { name, kind, configured: true, updatedAt, revision }
        : { name, kind, value: payload, updatedAt, revision },
    )
  }
  readSecret(name: string): string | undefined {
    if (this.availability !== "ready" || !this.key) return undefined
    const row = this.row(name)
    if (row?.kind !== "secret") return undefined
    try {
      return decrypt(this.key, name, row.payload)
    } catch {
      this.availability = "locked"
      return undefined
    }
  }
  readVariable(name: string): string | undefined {
    const row = this.row(name)
    return row?.kind === "variable" ? row.payload : undefined
  }
  setSecret(name: string, value: string, metadata: RuntimeConfigMetadata): void {
    this.validate(name, "secret", value, metadata)
    this.assertSecrets()
    this.put(name, "secret", encrypt(this.key as Buffer, name, value), metadata)
  }
  setVariable(name: string, value: string, metadata: RuntimeConfigMetadata): void {
    this.validate(name, "variable", value, metadata)
    this.put(name, "variable", value, metadata)
  }
  delete(name: string): void {
    validateRuntimeConfigName(name)
    const row = this.row(name)
    if (!row) throw new RuntimeConfigError("missing")
    if (row.kind === "secret") this.assertSecrets()
    this.db.prepare("DELETE FROM runtime_config WHERE name=?").run(name)
  }
  private assertSecrets(): void {
    if (!this.verifySecrets())
      throw new RuntimeConfigError(this.availability === "locked" ? "locked" : "unavailable")
  }
  private row(name: string): Row | undefined {
    return this.db.prepare("SELECT * FROM runtime_config WHERE name=?").get(name) as Row | undefined
  }
  private validate(
    name: string,
    kind: Row["kind"],
    value: string,
    metadata: RuntimeConfigMetadata,
  ): void {
    validateRuntimeConfigName(name)
    if (
      typeof value !== "string" ||
      Buffer.from(value, "utf8").toString("utf8") !== value ||
      Buffer.byteLength(value, "utf8") > 8192 ||
      (kind === "secret" && value.length === 0) ||
      !Number.isSafeInteger(metadata.revision) ||
      metadata.revision < 1 ||
      !Number.isSafeInteger(metadata.updatedAt) ||
      metadata.updatedAt < 0
    )
      throw new RuntimeConfigError("invalid")
    const previous = this.row(name)
    if (previous && previous.kind !== kind) throw new RuntimeConfigError("kind")
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM runtime_config").get() as { n: number }
    if (!previous && count.n >= 256) throw new RuntimeConfigError("limit")
  }
  private put(
    name: string,
    kind: Row["kind"],
    payload: string,
    metadata: RuntimeConfigMetadata,
  ): void {
    this.db
      .prepare(`INSERT INTO runtime_config VALUES (?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET
      payload=excluded.payload, updatedAt=excluded.updatedAt, revision=excluded.revision`)
      .run(name, kind, payload, metadata.updatedAt, metadata.revision)
  }
}
