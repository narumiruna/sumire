import type { DatabaseSync } from "node:sqlite"
import type {
  ServiceStatusDeliveryResponse,
  ServiceStatusDiagnostic,
} from "@narumitw/sumire-contracts"
import type { StatusComponent, StatusImpact, StatusProviderId } from "@narumitw/sumire-status-page"
import type { StatusEvent } from "./events.js"

export interface DeliveryCheckpoint {
  chatId: number
  provider: StatusProviderId
  eventId: string
  fingerprint: string
  active: number
  maintenance: number
  components?: StatusComponent[]
  impact?: StatusImpact
}

export interface PendingStatusNotification {
  chatId: number
  provider: StatusProviderId
  eventId: string
  fingerprint: string
  event: StatusEvent
  change: "new" | "update" | "resolved"
  dueAt: number
  firstSeenAt: number
  changes: number
  ruleFingerprint: string
  initial: boolean
  version: number
}

type CheckpointRow = Omit<DeliveryCheckpoint, "components" | "impact"> & {
  components: string | null
  impact: StatusImpact | null
}
type PendingRow = Omit<PendingStatusNotification, "event" | "initial"> & {
  event: string
  initial: number
}

const maxPending = 10_000
const maxPendingPerChat = 100
const maxEventBytes = 256 * 1024
const maxPendingBytes = 16 * 1024 * 1024
const retention = 30 * 24 * 3600_000
const diagnostics: ReadonlySet<ServiceStatusDiagnostic> = new Set([
  "source_unavailable",
  "delivery_failed",
  "forbidden",
  "chat_unavailable",
  "timeout",
  "queue_full",
  "cancelled",
  "rate_limited",
])
const checkpointColumns =
  "chat_id AS chatId, provider, event_id AS eventId, fingerprint, active, maintenance, components, impact"
const pendingColumns =
  "chat_id AS chatId, provider, event_id AS eventId, fingerprint, event, change_kind AS change, due_at AS dueAt, first_seen_at AS firstSeenAt, changes, rule_fingerprint AS ruleFingerprint, initial, version"
const pendingOrder = "due_at, chat_id, provider, event_id"

function checkpoint(row: CheckpointRow): DeliveryCheckpoint {
  const { components, impact, ...stored } = row
  return {
    ...stored,
    ...(components !== null ? { components: JSON.parse(components) as StatusComponent[] } : {}),
    ...(impact !== null ? { impact } : {}),
  }
}

function notification(row: PendingRow): PendingStatusNotification {
  return { ...row, event: JSON.parse(row.event) as StatusEvent, initial: Boolean(row.initial) }
}

function pendingFilter(chatId?: number, provider?: StatusProviderId, eventId?: string) {
  const clauses: string[] = []
  const values: (number | string)[] = []
  for (const [column, value] of [
    ["chat_id", chatId],
    ["provider", provider],
    ["event_id", eventId],
  ] as const) {
    if (value === undefined) continue
    clauses.push(`${column}=?`)
    values.push(value)
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", values }
}

/** Status storage shares the administration database and its single-process owner. */
export class StatusDeliveryState {
  constructor(private readonly db: DatabaseSync) {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS status_meta (
          id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL,
          queue_version INTEGER NOT NULL DEFAULT 0
        );
      `)
      const schema = this.db.prepare("SELECT version FROM status_meta WHERE id=1").get() as
        | { version: number }
        | undefined
      if (schema && schema.version > 1)
        throw new Error("Service status database schema is newer than this application")
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS status_deliveries (
          chat_id INTEGER NOT NULL, provider TEXT NOT NULL, event_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL, active INTEGER NOT NULL, maintenance INTEGER NOT NULL,
          touched INTEGER NOT NULL, components TEXT, impact TEXT,
          PRIMARY KEY (chat_id, provider, event_id)
        );
        CREATE TABLE IF NOT EXISTS status_pending (
          chat_id INTEGER NOT NULL, provider TEXT NOT NULL, event_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL, event TEXT NOT NULL, event_bytes INTEGER NOT NULL,
          change_kind TEXT NOT NULL, due_at INTEGER NOT NULL, first_seen_at INTEGER NOT NULL,
          changes INTEGER NOT NULL, rule_fingerprint TEXT NOT NULL, initial INTEGER NOT NULL,
          version INTEGER NOT NULL,
          PRIMARY KEY (chat_id, provider, event_id)
        );
        CREATE INDEX IF NOT EXISTS status_pending_due ON status_pending(due_at,chat_id,provider,event_id);
        CREATE TABLE IF NOT EXISTS status_source_health (
          provider TEXT PRIMARY KEY CHECK(provider IN ('github','openai','claude','cloudflare')),
          last_attempt_at INTEGER NOT NULL, last_success_at INTEGER, last_failure_at INTEGER,
          last_error TEXT
        );
        CREATE TABLE IF NOT EXISTS status_delivery_health (
          chat_id INTEGER NOT NULL,
          provider TEXT NOT NULL CHECK(provider IN ('github','openai','claude','cloudflare','test')),
          last_attempt_at INTEGER NOT NULL, last_success_at INTEGER, last_failure_at INTEGER,
          last_error TEXT, PRIMARY KEY (chat_id, provider)
        );
      `)
      const columns = this.db.prepare("PRAGMA table_info(status_deliveries)").all() as {
        name: string
      }[]
      for (const name of ["components", "impact"]) {
        if (!columns.some((column) => column.name === name))
          this.db.exec(`ALTER TABLE status_deliveries ADD COLUMN ${name} TEXT`)
      }
      this.db.exec("INSERT OR IGNORE INTO status_meta(id,version) VALUES (1,1)")
      this.db.exec("UPDATE status_meta SET version=1 WHERE id=1")
    })
  }

  private transaction<T>(operation: () => T): T {
    // Savepoints also preserve the caller's transaction on the shared database.
    this.db.exec("SAVEPOINT status_delivery_state")
    try {
      const result = operation()
      this.db.exec("RELEASE status_delivery_state")
      return result
    } catch (error) {
      this.db.exec("ROLLBACK TO status_delivery_state; RELEASE status_delivery_state")
      throw error
    }
  }

  get(chatId: number, provider: StatusProviderId, eventId: string): DeliveryCheckpoint | undefined {
    const row = this.db
      .prepare(
        `SELECT ${checkpointColumns} FROM status_deliveries WHERE chat_id=? AND provider=? AND event_id=?`,
      )
      .get(chatId, provider, eventId) as CheckpointRow | undefined
    return row && checkpoint(row)
  }

  active(provider: StatusProviderId): DeliveryCheckpoint[] {
    const rows = this.db
      .prepare(
        `SELECT ${checkpointColumns} FROM status_deliveries WHERE provider=? AND active=1 ORDER BY event_id, chat_id`,
      )
      .all(provider) as CheckpointRow[]
    return rows.map(checkpoint)
  }

  acknowledge(
    chatId: number,
    provider: StatusProviderId,
    eventId: string,
    fingerprint: string,
    active: boolean,
    maintenance: boolean,
    now: number,
    metadata?: { components: StatusComponent[]; impact: StatusImpact },
  ) {
    this.db
      .prepare(
        `INSERT INTO status_deliveries
          (chat_id,provider,event_id,fingerprint,active,maintenance,touched,components,impact)
          VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(chat_id,provider,event_id) DO UPDATE SET
          fingerprint=excluded.fingerprint,active=excluded.active,maintenance=excluded.maintenance,
          touched=excluded.touched,
          components=COALESCE(excluded.components,status_deliveries.components),
          impact=COALESCE(excluded.impact,status_deliveries.impact)`,
      )
      .run(
        chatId,
        provider,
        eventId,
        fingerprint,
        Number(active),
        Number(maintenance),
        now,
        metadata ? JSON.stringify(metadata.components) : null,
        metadata?.impact ?? null,
      )
  }

  pendingGet(
    chatId: number,
    provider: StatusProviderId,
    eventId: string,
  ): PendingStatusNotification | undefined {
    const row = this.db
      .prepare(
        `SELECT ${pendingColumns} FROM status_pending WHERE chat_id=? AND provider=? AND event_id=?`,
      )
      .get(chatId, provider, eventId) as PendingRow | undefined
    return row && notification(row)
  }

  pending(chatId?: number, provider?: StatusProviderId): PendingStatusNotification[] {
    const filter = pendingFilter(chatId, provider)
    const rows = this.db
      .prepare(
        `SELECT ${pendingColumns} FROM status_pending ${filter.where} ORDER BY ${pendingOrder} LIMIT ${maxPending}`,
      )
      .all(...filter.values) as PendingRow[]
    return rows.map(notification)
  }

  admit(input: Omit<PendingStatusNotification, "version">): boolean {
    const event = JSON.stringify(input.event)
    const bytes = Buffer.byteLength(event)
    if (bytes > maxEventBytes) return false
    return this.transaction(() => {
      const previous = this.db
        .prepare(
          "SELECT event_bytes AS bytes FROM status_pending WHERE chat_id=? AND provider=? AND event_id=?",
        )
        .get(input.chatId, input.provider, input.eventId) as { bytes: number } | undefined
      const total = this.db
        .prepare(
          "SELECT COUNT(*) AS count, COALESCE(SUM(event_bytes),0) AS bytes FROM status_pending",
        )
        .get() as { count: number; bytes: number }
      if (total.bytes - (previous?.bytes ?? 0) + bytes > maxPendingBytes) return false
      if (!previous) {
        const chat = this.db
          .prepare("SELECT COUNT(*) AS count FROM status_pending WHERE chat_id=?")
          .get(input.chatId) as { count: number }
        if (total.count >= maxPending || chat.count >= maxPendingPerChat) return false
      }
      // A global token prevents version reuse after cancellation or successful removal.
      const version = this.db
        .prepare(
          "UPDATE status_meta SET queue_version=queue_version+1 WHERE id=1 RETURNING queue_version AS version",
        )
        .get() as { version: number }
      this.db
        .prepare(
          `INSERT INTO status_pending
            (chat_id,provider,event_id,fingerprint,event,event_bytes,change_kind,due_at,first_seen_at,
             changes,rule_fingerprint,initial,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(chat_id,provider,event_id) DO UPDATE SET
            fingerprint=excluded.fingerprint,event=excluded.event,event_bytes=excluded.event_bytes,
            change_kind=excluded.change_kind,due_at=excluded.due_at,first_seen_at=excluded.first_seen_at,
            changes=excluded.changes,rule_fingerprint=excluded.rule_fingerprint,
            initial=excluded.initial,version=excluded.version`,
        )
        .run(
          input.chatId,
          input.provider,
          input.eventId,
          input.fingerprint,
          event,
          bytes,
          input.change,
          input.dueAt,
          input.firstSeenAt,
          input.changes,
          input.ruleFingerprint,
          Number(input.initial),
          version.version,
        )
      return true
    })
  }

  complete(row: PendingStatusNotification, now: number): boolean {
    return this.transaction(() => {
      const current = this.db
        .prepare("SELECT version FROM status_pending WHERE chat_id=? AND provider=? AND event_id=?")
        .get(row.chatId, row.provider, row.eventId) as { version: number } | undefined
      if (!current || current.version < row.version) return false
      this.acknowledge(
        row.chatId,
        row.provider,
        row.eventId,
        row.fingerprint,
        row.event.active,
        row.event.maintenance,
        now,
        { components: row.event.components, impact: row.event.impact },
      )
      this.db
        .prepare(
          "DELETE FROM status_pending WHERE chat_id=? AND provider=? AND event_id=? AND version=?",
        )
        .run(row.chatId, row.provider, row.eventId, row.version)
      return true
    })
  }

  clearPending(chatId: number, provider?: StatusProviderId, eventId?: string): void {
    const filter = pendingFilter(chatId, provider, eventId)
    this.db.prepare(`DELETE FROM status_pending ${filter.where}`).run(...filter.values)
  }

  forget(chatId: number, provider: StatusProviderId, eventId: string): void {
    this.transaction(() => {
      this.clearPending(chatId, provider, eventId)
      this.db
        .prepare("DELETE FROM status_deliveries WHERE chat_id=? AND provider=? AND event_id=?")
        .run(chatId, provider, eventId)
    })
  }

  due(now: number, limit = 100): PendingStatusNotification[] {
    const rows = this.db
      .prepare(
        `SELECT ${pendingColumns} FROM status_pending WHERE due_at<=? ORDER BY ${pendingOrder} LIMIT ?`,
      )
      .all(now, Math.max(0, Math.min(maxPending, limit))) as PendingRow[]
    return rows.map(notification)
  }

  nextDue(): number | undefined {
    const row = this.db.prepare("SELECT MIN(due_at) AS due FROM status_pending").get() as {
      due: number | null
    }
    return row.due ?? undefined
  }

  /** Remove revoked subscriptions. Keep active incidents until recovery can be confirmed. */
  prune(chatIds: readonly number[], providers: readonly StatusProviderId[], now: number) {
    this.db
      .prepare(
        "DELETE FROM status_deliveries WHERE chat_id NOT IN (SELECT value FROM json_each(?)) OR provider NOT IN (SELECT value FROM json_each(?)) OR (active=0 AND touched<?)",
      )
      .run(JSON.stringify(chatIds), JSON.stringify(providers), now - retention)
  }

  pruneSubscriptions(
    subscriptions: readonly {
      chatId: number
      providers: readonly StatusProviderId[]
      ruleFingerprint: string
    }[],
    enabled: boolean,
    now: number,
  ): void {
    this.transaction(() => {
      const chats = JSON.stringify(subscriptions.map((subscription) => subscription.chatId))
      this.db
        .prepare(
          "DELETE FROM status_deliveries WHERE chat_id NOT IN (SELECT value FROM json_each(?)) OR (active=0 AND touched<?)",
        )
        .run(chats, now - retention)
      this.db
        .prepare(
          "DELETE FROM status_pending WHERE ?=0 OR chat_id NOT IN (SELECT value FROM json_each(?))",
        )
        .run(Number(enabled), chats)
      this.db
        .prepare(
          "DELETE FROM status_delivery_health WHERE chat_id NOT IN (SELECT value FROM json_each(?))",
        )
        .run(chats)
      const checkpoints = this.db.prepare(
        "DELETE FROM status_deliveries WHERE chat_id=? AND provider NOT IN (SELECT value FROM json_each(?))",
      )
      const pending = this.db.prepare(
        "DELETE FROM status_pending WHERE chat_id=? AND (provider NOT IN (SELECT value FROM json_each(?)) OR rule_fingerprint<>?)",
      )
      const results = this.db.prepare(
        "DELETE FROM status_delivery_health WHERE chat_id=? AND provider<>'test' AND provider NOT IN (SELECT value FROM json_each(?))",
      )
      for (const subscription of subscriptions) {
        const providers = JSON.stringify(subscription.providers)
        checkpoints.run(subscription.chatId, providers)
        pending.run(subscription.chatId, providers, subscription.ruleFingerprint)
        results.run(subscription.chatId, providers)
      }
    })
  }

  recordSource(
    provider: StatusProviderId,
    success: boolean,
    now: number,
    code?: ServiceStatusDiagnostic,
  ): void {
    this.record("status_source_health", provider, success, now, code)
  }

  recordAttempt(chatId: number, provider: StatusProviderId | "test", now: number): void {
    this.db
      .prepare(
        `INSERT INTO status_delivery_health (chat_id,provider,last_attempt_at) VALUES (?,?,?)
          ON CONFLICT(chat_id,provider) DO UPDATE SET last_attempt_at=excluded.last_attempt_at`,
      )
      .run(chatId, provider, now)
  }

  recordDelivery(
    chatId: number,
    provider: StatusProviderId | "test",
    success: boolean,
    now: number,
    code?: ServiceStatusDiagnostic,
  ): void {
    this.record("status_delivery_health", provider, success, now, code, chatId)
  }

  private record(
    table: "status_source_health" | "status_delivery_health",
    provider: StatusProviderId | "test",
    success: boolean,
    now: number,
    code?: ServiceStatusDiagnostic,
    chatId?: number,
  ): void {
    const keys = chatId === undefined ? "provider" : "chat_id,provider"
    const values = chatId === undefined ? [provider] : [chatId, provider]
    this.db
      .prepare(
        `INSERT INTO ${table} (${keys},last_attempt_at,last_success_at,last_failure_at,last_error)
          VALUES (${values.map(() => "?").join(",")},?,?,?,?) ON CONFLICT(${keys}) DO UPDATE SET
          last_attempt_at=excluded.last_attempt_at,
          last_success_at=COALESCE(excluded.last_success_at,${table}.last_success_at),
          last_failure_at=COALESCE(excluded.last_failure_at,${table}.last_failure_at),
          last_error=CASE WHEN excluded.last_failure_at IS NULL THEN ${table}.last_error ELSE excluded.last_error END`,
      )
      .run(
        ...values,
        now,
        success ? now : null,
        success ? null : now,
        !success && code && diagnostics.has(code) ? code : null,
      )
  }

  lastTestAttempt(chatId: number): number | undefined {
    const row = this.db
      .prepare(
        "SELECT last_attempt_at AS time FROM status_delivery_health WHERE chat_id=? AND provider='test'",
      )
      .get(chatId) as { time: number } | undefined
    return row?.time
  }

  results(
    query: { offset: number; limit: number; chatId?: number; provider?: StatusProviderId | "test" },
    now: number,
    nextPollAt: number | null,
  ): ServiceStatusDeliveryResponse {
    const clauses: string[] = []
    const values: (number | string)[] = []
    if (query.chatId !== undefined) {
      clauses.push("destinations.chat_id=?")
      values.push(query.chatId)
    }
    if (query.provider !== undefined) {
      clauses.push("destinations.provider=?")
      values.push(query.provider)
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""
    const union = `WITH pending AS (
      SELECT chat_id,provider,COUNT(*) AS count,MIN(due_at) AS due FROM status_pending GROUP BY chat_id,provider
    ), destinations AS (
      SELECT chat_id,provider FROM status_delivery_health UNION SELECT chat_id,provider FROM pending
    )`
    const total = this.db
      .prepare(`${union} SELECT COUNT(*) AS count FROM destinations ${where}`)
      .get(...values) as { count: number }
    const limit = Math.min(100, query.limit)
    const items = this.db
      .prepare(
        `${union} SELECT destinations.chat_id AS chatId,destinations.provider,
          health.last_attempt_at AS lastAttemptAt,health.last_success_at AS lastSuccessAt,
          health.last_failure_at AS lastFailureAt,health.last_error AS lastError,
          COALESCE(pending.count,0) AS pendingCount,pending.due AS nextDueAt
          FROM destinations LEFT JOIN status_delivery_health AS health USING(chat_id,provider)
          LEFT JOIN pending USING(chat_id,provider) ${where}
          ORDER BY destinations.chat_id,destinations.provider LIMIT ? OFFSET ?`,
      )
      .all(...values, limit, query.offset) as unknown as ServiceStatusDeliveryResponse["items"]
    const sources = this.db
      .prepare(
        `SELECT provider,last_attempt_at AS lastAttemptAt,last_success_at AS lastSuccessAt,
          last_failure_at AS lastFailureAt,last_error AS lastError FROM status_source_health
          ${query.provider === undefined ? "" : "WHERE provider=?"} ORDER BY provider`,
      )
      .all(
        ...(query.provider === undefined ? [] : [query.provider]),
      ) as unknown as ServiceStatusDeliveryResponse["sources"]
    return {
      items,
      sources,
      offset: query.offset,
      limit,
      total: total.count,
      serverTime: now,
      nextPollAt,
    }
  }
}
