import { createHash, randomBytes } from "node:crypto"
import { chmodSync, mkdirSync } from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { AuditEntry, Chat, Snapshot } from "@narumitw/sumire-contracts"
import {
  effectivePolicy,
  initialPolicy,
  POLICY_MAX_NAMES,
  policySchema,
  validateReferences,
} from "@narumitw/sumire-policy"
import type { AuditFilters } from "./audit-query.js"

export class AdminError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
export const sessionMaxAgeMs = 30 * 24 * 3600_000
const sessionIdleTimeoutMs = 7 * 24 * 3600_000
export const digest = (value: string) => createHash("sha256").update(value).digest("hex")
export const token = () => randomBytes(32).toString("base64url")
export type { Snapshot } from "@narumitw/sumire-contracts"

/** One process owns this database. Secrets are never stored in audit values. */
export class AdminStore {
  readonly db: DatabaseSync
  constructor(
    readonly file: string,
    readonly adminId: number,
  ) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(file)
    chmodSync(file, 0o600)
    const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number }
    if (version.user_version > 3) {
      this.db.close()
      throw new Error("Admin database schema is newer than this application")
    }
    this.db.exec("PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON; BEGIN IMMEDIATE")
    try {
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS known_tools (name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS imports (name TEXT PRIMARY KEY, report TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, applied INTEGER NOT NULL, status TEXT NOT NULL, policy TEXT NOT NULL, epoch INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, actor TEXT NOT NULL, time INTEGER NOT NULL, operation TEXT NOT NULL, revision INTEGER NOT NULL, outcome TEXT NOT NULL, target TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, actor TEXT NOT NULL, created INTEGER NOT NULL, touched INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS passkeys (actor TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, public_key BLOB NOT NULL, counter INTEGER NOT NULL, user_handle TEXT NOT NULL, device_type TEXT NOT NULL, backed_up INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS passkey_setup (actor TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, origin TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS passkey_challenges (hash TEXT PRIMARY KEY, actor TEXT NOT NULL, kind TEXT NOT NULL, challenge TEXT NOT NULL, setup_hash TEXT NOT NULL, user_handle TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chat_access_requests (hash TEXT PRIMARY KEY, chat_id INTEGER NOT NULL UNIQUE, type TEXT NOT NULL, name TEXT NOT NULL, origin TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS access_reviews (fingerprint TEXT PRIMARY KEY, revision INTEGER NOT NULL, actor TEXT NOT NULL, reviewed INTEGER NOT NULL, decisions TEXT NOT NULL);
      DROP TABLE IF EXISTS login;
      PRAGMA user_version = 3;
    `)
      if (version.user_version < 2) this.db.exec("DELETE FROM sessions")
      this.db
        .prepare("INSERT OR IGNORE INTO settings VALUES (1,1,0,'pending',?,1)")
        .run(JSON.stringify(initialPolicy()))
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      this.db.close()
      throw error
    }
  }
  snapshot(): Snapshot {
    const row = this.db.prepare("SELECT * FROM settings WHERE id=1").get() as {
      revision: number
      applied: number
      status: string
      policy: string
      epoch: number
    }
    return {
      revision: row.revision,
      epoch: row.epoch,
      applied: row.applied,
      status: row.status,
      policy: policySchema.parse(JSON.parse(row.policy)),
    }
  }
  /** persist must be synchronous; it shares this revision's transaction and rollback. */
  save(
    input: unknown,
    revision: number,
    actor: string,
    operation = "settings.update",
    target = "settings",
    persist?: () => void,
  ) {
    const policy = policySchema.parse(input)
    try {
      validateReferences(policy)
    } catch (error) {
      throw new AdminError(
        400,
        error instanceof Error ? error.message : "Invalid settings references",
      )
    }
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const changed = this.db
        .prepare(
          "UPDATE settings SET revision=revision+1, epoch=epoch+?, status='pending', policy=? WHERE id=1 AND revision=?",
        )
        .run(Number(operation !== "chat.model.update"), JSON.stringify(policy), revision)
      if (!changed.changes) throw new AdminError(409, "Settings changed; reload before saving")
      this.audit(actor, operation, revision + 1, "saved", target)
      for (const key of Object.keys(policy.chats)) {
        const id = Number(key)
        if (!this.db.prepare("SELECT id FROM chats WHERE id=?").get(id))
          this.observe(id, id > 0 ? "private" : "group", key)
      }
      persist?.()
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
    return this.snapshot()
  }
  /** Remember tools. Enable first-seen names only when enableNew is true. */
  registerTools(names: readonly string[], enableNew = true) {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const state = this.snapshot()
      const remember = this.db.prepare("INSERT OR IGNORE INTO known_tools VALUES (?)")
      if (!enableNew)
        for (const name of policySchema.shape.tools.parse([...new Set(names)])) remember.run(name)
      // Existing selections are already known, including selections denied globally.
      for (const name of [
        ...state.policy.tools,
        ...(state.policy.defaults.tools ?? []),
        ...Object.values(state.policy.chats).flatMap((chat) => chat.tools ?? []),
      ])
        remember.run(name)
      const capacity = Math.max(
        0,
        Math.min(
          POLICY_MAX_NAMES - state.policy.tools.length,
          POLICY_MAX_NAMES - (state.policy.defaults.tools?.length ?? 0),
        ),
      )
      const known = new Set(
        (this.db.prepare("SELECT name FROM known_tools").all() as { name: string }[]).map(
          (row) => row.name,
        ),
      )
      // Leave overflow names unknown. Retry them when policy capacity is available.
      const added = [...new Set(names)].filter((name) => !known.has(name)).slice(0, capacity)
      for (const name of added) remember.run(name)
      if (added.length) {
        state.policy.tools.push(...added)
        state.policy.defaults.tools = [...(state.policy.defaults.tools ?? []), ...added]
        const policy = policySchema.parse(state.policy)
        // No model, admission, server gate, or explicit chat selection changes.
        // Pending and failed revisions remain unavailable until normal application.
        this.db
          .prepare(
            "UPDATE settings SET revision=revision+1, applied=CASE WHEN status='applied' AND applied=revision THEN revision+1 ELSE applied END, policy=? WHERE id=1",
          )
          .run(JSON.stringify(policy))
        this.audit("system", "tools.register", state.revision + 1, "enabled", added.join(", "))
      }
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }
  audit(actor: string, operation: string, revision: number, outcome: string, target = "settings") {
    this.db
      .prepare(
        "INSERT INTO audit(actor,time,operation,revision,outcome,target) VALUES (?,?,?,?,?,?)",
      )
      .run(actor, Date.now(), operation, revision, outcome, target)
    this.db.exec("DELETE FROM audit WHERE id <= (SELECT COALESCE(MAX(id),0)-10000 FROM audit)")
  }
  applied(revision: number, success: boolean) {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const changed = this.db
        .prepare(
          "UPDATE settings SET status=?, applied=CASE WHEN ? THEN ? ELSE applied END WHERE id=1 AND revision=?",
        )
        .run(success ? "applied" : "failed", Number(success), revision, revision)
      this.audit(
        "system",
        "settings.apply",
        revision,
        !changed.changes ? "stale" : success ? "applied" : "failed",
      )
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }
  allows(chatId: number) {
    const state = this.snapshot()
    return (
      state.status === "applied" &&
      state.applied === state.revision &&
      effectivePolicy(state.policy, chatId).enabled
    )
  }
  assertChat(chatId: number, revision?: number) {
    if (!this.allows(chatId) || (revision !== undefined && revision !== this.snapshot().revision))
      throw new AdminError(403, "Chat policy is unavailable or changed")
  }
  allowsTool(chatId: number, name: string, server?: string) {
    if (!this.allows(chatId)) return false
    const policy = effectivePolicy(this.snapshot().policy, chatId)
    return policy.tools.includes(name) && (!server || policy.servers.includes(server))
  }
  observe(id: number, type: string, name: string) {
    if (!Number.isSafeInteger(id) || id === 0) return
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM chats").get() as { n: number }
    if (count.n >= 1000 && !this.db.prepare("SELECT id FROM chats WHERE id=?").get(id)) return
    this.db
      .prepare(
        "INSERT INTO chats VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET type=excluded.type,name=excluded.name",
      )
      .run(id, type.slice(0, 32), name.slice(0, 128))
  }
  listChats(offset: number): Chat[] {
    return this.db
      .prepare("SELECT * FROM chats ORDER BY id LIMIT 100 OFFSET ?")
      .all(offset) as Chat[]
  }
  listAudit(offset: number, filters: AuditFilters = {}): AuditEntry[] {
    const clauses: string[] = []
    const values: (string | number)[] = []
    for (const key of ["actor", "operation", "outcome"] as const) {
      if (filters[key] !== undefined) {
        clauses.push(`${key} = ?`)
        values.push(filters[key])
      }
    }
    if (filters.from !== undefined) {
      clauses.push("time >= ?")
      values.push(filters.from)
    }
    if (filters.to !== undefined) {
      clauses.push("time <= ?")
      values.push(filters.to)
    }
    return this.db
      .prepare(
        `SELECT * FROM audit ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY id DESC LIMIT 100 OFFSET ?`,
      )
      .all(...values, offset) as AuditEntry[]
  }
  createSession(actor: string, now = Date.now()) {
    this.prune(now)
    const value = token()
    const csrf = token()
    this.db
      .prepare("INSERT INTO sessions VALUES (?,?,?,?,?)")
      .run(digest(value), csrf, actor, now, now)
    return { value, csrf }
  }
  session(value: string, now = Date.now()) {
    this.prune(now)
    const row = this.db.prepare("SELECT * FROM sessions WHERE hash=?").get(digest(value)) as
      | { csrf: string; actor: string; created: number; touched: number }
      | undefined
    if (!row || !this.adminId || row.actor !== String(this.adminId)) return undefined
    this.db.prepare("UPDATE sessions SET touched=? WHERE hash=?").run(now, digest(value))
    return row
  }
  revoke(value: string) {
    this.db.prepare("DELETE FROM sessions WHERE hash=?").run(digest(value))
  }
  prune(now = Date.now()) {
    this.db
      .prepare("DELETE FROM sessions WHERE created<=? OR touched<=?")
      .run(now - sessionMaxAgeMs, now - sessionIdleTimeoutMs)
    this.db.prepare("DELETE FROM passkey_setup WHERE created<=?").run(now - 5 * 60_000)
    this.db.prepare("DELETE FROM passkey_challenges WHERE created<=?").run(now - 5 * 60_000)
  }
  close() {
    this.db.close()
  }
}
