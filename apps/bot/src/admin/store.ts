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
import type { ChatFilters } from "./chat-query.js"

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
      // Preserve the JavaScript case folding used by the directory before server search.
      this.db.function("chat_lower", { deterministic: true }, (value) =>
        typeof value === "string" ? value.toLowerCase() : "",
      )
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS known_tools (name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS known_skills (name TEXT PRIMARY KEY);
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
          "UPDATE settings SET revision=revision+1, epoch=epoch+1, status='pending', policy=? WHERE id=1 AND revision=?",
        )
        .run(JSON.stringify(policy), revision)
      if (!changed.changes) throw new AdminError(409, "Settings changed; reload before saving")
      this.audit(actor, operation, revision + 1, "saved", target)
      for (const key of Object.keys(policy.chats)) {
        const id = Number(key)
        if (!this.db.prepare("SELECT id FROM chats WHERE id=?").get(id))
          this.observe(id, id > 0 ? "private" : "group", key, "inferred")
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
    this.registerNames("tools", names, enableNew)
  }
  /** Enable first-seen skills without restoring manually removed selections. */
  registerSkills(names: string[]) {
    this.registerNames("skills", names)
  }
  private registerNames(key: "tools" | "skills", names: readonly string[], enableNew = true) {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const state = this.snapshot()
      const remember = this.db.prepare(`INSERT OR IGNORE INTO known_${key} VALUES (?)`)
      if (!enableNew)
        for (const name of policySchema.shape[key].parse([...new Set(names)])) remember.run(name)
      // Existing selections are already known, including selections denied globally.
      for (const name of [
        ...state.policy[key],
        ...(state.policy.defaults[key] ?? []),
        ...Object.values(state.policy.chats).flatMap((chat) => chat[key] ?? []),
      ])
        remember.run(name)
      const capacity = Math.max(
        0,
        Math.min(
          POLICY_MAX_NAMES - state.policy[key].length,
          POLICY_MAX_NAMES - (state.policy.defaults[key]?.length ?? 0),
        ),
      )
      const known = new Set(
        (this.db.prepare(`SELECT name FROM known_${key}`).all() as { name: string }[]).map(
          (row) => row.name,
        ),
      )
      // Leave overflow names unknown. Retry them when policy capacity is available.
      const added = [...new Set(names)].filter((name) => !known.has(name)).slice(0, capacity)
      for (const name of added) remember.run(name)
      if (added.length) {
        state.policy[key].push(...added)
        state.policy.defaults[key] = [...(state.policy.defaults[key] ?? []), ...added]
        const policy = policySchema.parse(state.policy)
        // No model, admission, server gate, or explicit chat selection changes.
        // Pending and failed revisions remain unavailable until normal application.
        this.db
          .prepare(
            "UPDATE settings SET revision=revision+1, applied=CASE WHEN status='applied' AND applied=revision THEN revision+1 ELSE applied END, policy=? WHERE id=1",
          )
          .run(JSON.stringify(policy))
        this.audit("system", `${key}.register`, state.revision + 1, "enabled", added.join(", "))
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
  /** Inferred inventory only creates rows. Missing observed fields preserve known metadata. */
  observe(id: number, type?: string, name?: string, source: "observed" | "inferred" = "observed") {
    if (!Number.isSafeInteger(id) || id === 0) return
    const count = this.db.prepare("SELECT COUNT(*) AS n FROM chats").get() as { n: number }
    if (count.n >= 1000 && !this.db.prepare("SELECT id FROM chats WHERE id=?").get(id)) return
    const observedName = name?.trim()
    const knownName = observedName && observedName !== String(id) ? observedName.slice(0, 128) : ""
    const knownType = type?.trim().slice(0, 32) ?? ""
    this.db
      .prepare(
        `INSERT INTO chats VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET
          type=CASE WHEN ?='observed' AND excluded.type<>'' THEN excluded.type ELSE chats.type END,
          name=CASE WHEN ?='observed' AND excluded.name<>'' THEN excluded.name ELSE chats.name END`,
      )
      .run(id, knownType, knownName, source, source)
  }
  listChats(offset: number, filters?: ChatFilters): Chat[] {
    const clauses: string[] = []
    const values: (string | number)[] = []
    if (filters?.id !== undefined) {
      clauses.push("id=?")
      values.push(filters.id)
    }
    if (filters?.q) {
      // instr treats %, _, and backslash literally. IDs are complete canonical numeric values.
      const numeric = /^-?[1-9]\d*$/.test(filters.q) && Number.isSafeInteger(Number(filters.q))
      clauses.push(
        "((trim(name)<>CAST(id AS TEXT) AND instr(chat_lower(name),chat_lower(?))>0) OR id=?)",
      )
      values.push(filters.q, numeric ? Number(filters.q) : 0)
    }
    return this.db
      .prepare(
        `SELECT * FROM chats ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY id LIMIT 100 OFFSET ?`,
      )
      .all(...values, offset) as Chat[]
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
