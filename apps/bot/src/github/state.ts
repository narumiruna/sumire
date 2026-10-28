import { chmodSync, mkdirSync } from "node:fs"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { GithubMention } from "@narumitw/sumire-github-notifications"

export interface PendingMention {
  mention: GithubMention
  response: string | null
  model: string | null
}

/** One worker owns these checkpoints. Responses are committed before external delivery. */
export class GithubState {
  readonly #db: DatabaseSync

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    chmodSync(directory, 0o700)
    const file = path.join(directory, "state.sqlite")
    this.#db = new DatabaseSync(file)
    chmodSync(file, 0o600)
    this.#db.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS accounts (token_hash TEXT PRIMARY KEY, account_id INTEGER, since TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors (account_id INTEGER PRIMARY KEY, since TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mentions (
        key TEXT PRIMARY KEY, account_id INTEGER NOT NULL, mention TEXT NOT NULL,
        response TEXT, model TEXT, status TEXT NOT NULL DEFAULT 'pending'
      );
    `)
  }

  start(tokenHash: string, since: string): string {
    this.#db.prepare("INSERT OR IGNORE INTO accounts VALUES (?,NULL,?)").run(tokenHash, since)
    return (
      this.#db.prepare("SELECT since FROM accounts WHERE token_hash=?").get(tokenHash) as {
        since: string
      }
    ).since
  }

  account(tokenHash: string): number | undefined {
    const row = this.#db
      .prepare("SELECT account_id FROM accounts WHERE token_hash=?")
      .get(tokenHash)
    return (row?.account_id ?? undefined) as number | undefined
  }

  bind(tokenHash: string, accountId: number) {
    this.#db
      .prepare("UPDATE accounts SET account_id=? WHERE token_hash=?")
      .run(accountId, tokenHash)
  }

  since(accountId: number): string | undefined {
    const row = this.#db.prepare("SELECT since FROM cursors WHERE account_id=?").get(accountId)
    return row?.since as string | undefined
  }

  checkpoint(accountId: number, since: string) {
    this.#db
      .prepare(
        "INSERT INTO cursors VALUES (?,?) ON CONFLICT(account_id) DO UPDATE SET since=MAX(since,excluded.since)",
      )
      .run(accountId, since)
  }

  admit(mention: GithubMention) {
    this.#db
      .prepare("INSERT OR IGNORE INTO mentions (key,account_id,mention) VALUES (?,?,?)")
      .run(mention.key, mention.account.id, JSON.stringify(mention))
  }

  *pending(accountId: number): Iterable<PendingMention> {
    const rows = this.#db
      .prepare(
        "SELECT mention,response,model FROM mentions WHERE account_id=? AND status='pending' ORDER BY rowid",
      )
      .iterate(accountId) as Iterable<{
      mention: string
      response: string | null
      model: string | null
    }>
    for (const row of rows) {
      yield { mention: JSON.parse(row.mention), response: row.response, model: row.model }
    }
  }

  response(key: string, response: string, model: string) {
    this.#db
      .prepare("UPDATE mentions SET response=?,model=? WHERE key=? AND status='pending'")
      .run(response, model, key)
  }

  finish(key: string, status: "sent" | "ignored" | "failed") {
    this.#db.prepare("UPDATE mentions SET status=? WHERE key=?").run(status, key)
  }

  close() {
    this.#db.close()
  }
}
