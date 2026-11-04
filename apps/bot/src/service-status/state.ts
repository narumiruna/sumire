import type { DatabaseSync } from "node:sqlite"
import type { StatusProviderId } from "@narumitw/sumire-status-page"

export interface DeliveryCheckpoint {
  chatId: number
  provider: StatusProviderId
  eventId: string
  fingerprint: string
  active: number
  maintenance: number
}

/** Delivery acknowledgements share the administration database and its single-process owner. */
export class StatusDeliveryState {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS status_deliveries (
        chat_id INTEGER NOT NULL, provider TEXT NOT NULL, event_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, active INTEGER NOT NULL, maintenance INTEGER NOT NULL,
        touched INTEGER NOT NULL,
        PRIMARY KEY (chat_id, provider, event_id)
      );
    `)
  }

  get(chatId: number, provider: StatusProviderId, eventId: string) {
    return this.db
      .prepare(
        "SELECT chat_id AS chatId, provider, event_id AS eventId, fingerprint, active, maintenance FROM status_deliveries WHERE chat_id=? AND provider=? AND event_id=?",
      )
      .get(chatId, provider, eventId) as DeliveryCheckpoint | undefined
  }

  active(provider: StatusProviderId): DeliveryCheckpoint[] {
    return this.db
      .prepare(
        "SELECT chat_id AS chatId, provider, event_id AS eventId, fingerprint, active, maintenance FROM status_deliveries WHERE provider=? AND active=1 ORDER BY event_id, chat_id",
      )
      .all(provider) as unknown as DeliveryCheckpoint[]
  }

  acknowledge(
    chatId: number,
    provider: StatusProviderId,
    eventId: string,
    fingerprint: string,
    active: boolean,
    maintenance: boolean,
    now: number,
  ) {
    this.db
      .prepare(
        "INSERT INTO status_deliveries VALUES (?,?,?,?,?,?,?) ON CONFLICT(chat_id,provider,event_id) DO UPDATE SET fingerprint=excluded.fingerprint,active=excluded.active,maintenance=excluded.maintenance,touched=excluded.touched",
      )
      .run(chatId, provider, eventId, fingerprint, Number(active), Number(maintenance), now)
  }

  /** Remove revoked subscriptions. Keep active incidents until recovery can be confirmed. */
  prune(chatIds: readonly number[], providers: readonly StatusProviderId[], now: number) {
    const chats = JSON.stringify(chatIds)
    const sources = JSON.stringify(providers)
    this.db
      .prepare(
        "DELETE FROM status_deliveries WHERE chat_id NOT IN (SELECT value FROM json_each(?)) OR provider NOT IN (SELECT value FROM json_each(?)) OR (active=0 AND touched<?)",
      )
      .run(chats, sources, now - 30 * 24 * 3600_000)
  }
}
