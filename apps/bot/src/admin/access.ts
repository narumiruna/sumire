import { randomBytes } from "node:crypto"
import { effectivePolicy } from "./policy.js"
import { AdminError, type AdminStore, digest } from "./store.js"

export const accessTokenPattern = /^[a-f0-9]{64}$/
type Request = {
  chat_id: number
  type: string
  name: string
  origin: string
  created: number
  expires: number
}

/** Chat approval changes use the same policy transaction and application path as WebUI edits. */
export class ChatAccess {
  constructor(private readonly store: AdminStore) {}

  issue(chat: { id: number; type: string; name: string }, origin: string, now = Date.now()) {
    if (
      !Number.isSafeInteger(chat.id) ||
      chat.id === 0 ||
      !["private", "group", "supergroup"].includes(chat.type) ||
      (chat.type === "private" ? chat.id < 0 : chat.id > 0)
    )
      throw new AdminError(400, "Invalid chat")
    const { policy } = this.store.snapshot()
    if (effectivePolicy(policy, chat.id).enabled) return { approved: true as const }
    const db = this.store.db
    db.prepare("DELETE FROM chat_access_requests WHERE expires<=?").run(now)
    const previous = db
      .prepare("SELECT created FROM chat_access_requests WHERE chat_id=?")
      .get(chat.id) as { created: number } | undefined
    if (previous && previous.created > now - 60_000)
      throw new AdminError(429, "Wait one minute before requesting another approval link")
    const count = db.prepare("SELECT COUNT(*) AS n FROM chat_access_requests").get() as {
      n: number
    }
    if (!previous && count.n >= 1000)
      throw new AdminError(429, "Too many pending approval requests; try again later")
    const value = randomBytes(32).toString("hex")
    db.prepare(
      "INSERT INTO chat_access_requests VALUES (?,?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET hash=excluded.hash,type=excluded.type,name=excluded.name,origin=excluded.origin,created=excluded.created,expires=excluded.expires",
    ).run(digest(value), chat.id, chat.type, chat.name.slice(0, 128), origin, now, now + 900_000)
    return { approved: false as const, url: `${origin}/#allow=${value}` }
  }

  resolve(value: string, origin: string, now = Date.now()) {
    const row = accessTokenPattern.test(value)
      ? (this.store.db
          .prepare("SELECT * FROM chat_access_requests WHERE hash=? AND origin=? AND expires>?")
          .get(digest(value), origin, now) as Request | undefined)
      : undefined
    if (!row) throw new AdminError(410, "Approval link expired or is no longer valid")
    return { id: row.chat_id, type: row.type, name: row.name, expires: row.expires }
  }

  approve(value: string, origin: string, revision: number, actor: string) {
    const chat = this.resolve(value, origin)
    const policy = this.store.snapshot().policy
    const list = chat.id > 0 ? policy.privateUsers : policy.groups
    if (!list.includes(chat.id)) list.push(chat.id)
    const override = policy.chats[String(chat.id)]
    if (override) override.enabled = true
    return this.store.save(
      policy,
      revision,
      actor,
      "chat.access.approve",
      `chat:${chat.id}`,
      () => {
        const result = this.store.db
          .prepare("DELETE FROM chat_access_requests WHERE hash=? AND origin=? AND expires>?")
          .run(digest(value), origin, Date.now())
        if (!result.changes)
          throw new AdminError(410, "Approval link expired or is no longer valid")
        this.store.observe(chat.id, chat.type, chat.name)
      },
    )
  }

  reconciliation() {
    // The report is bounded by the same per-list limits as policy validation.
    if (this.store.whitelist.size > 2000) throw new AdminError(400, "Too many environment IDs")
    const ids = [...this.store.whitelist].sort((a, b) => a - b)
    if (
      ids.some((id) => !Number.isSafeInteger(id) || id === 0) ||
      ids.filter((id) => id > 0).length > 1000 ||
      ids.filter((id) => id < 0).length > 1000
    )
      throw new AdminError(400, "Invalid environment IDs")
    const fingerprint = digest(JSON.stringify(ids))
    const { revision, policy } = this.store.snapshot()
    const review = this.store.db
      .prepare("SELECT revision,actor,reviewed,decisions FROM access_reviews WHERE fingerprint=?")
      .get(fingerprint) as
      | { revision: number; actor: string; reviewed: number; decisions: string }
      | undefined
    return {
      fingerprint,
      revision,
      entries: ids.map((id) => ({
        id,
        status:
          policy.chats[String(id)]?.enabled === false
            ? ("disabled" as const)
            : (id > 0 ? policy.privateUsers : policy.groups).includes(id)
              ? ("present" as const)
              : ("missing" as const),
      })),
      review: review ? { ...review, decisions: JSON.parse(review.decisions) as unknown } : null,
    }
  }

  reconcile(fingerprint: string, selected: number[], revision: number, actor: string) {
    const report = this.reconciliation()
    if (report.fingerprint !== fingerprint)
      throw new AdminError(409, "Environment IDs changed; reload before reviewing")
    if (report.review) throw new AdminError(409, "Environment IDs have already been reviewed")
    const ids = new Set(selected)
    if (
      ids.size !== selected.length ||
      selected.some((id) => !report.entries.some((e) => e.id === id && e.status === "missing"))
    )
      throw new AdminError(400, "Select only missing environment IDs")
    const policy = this.store.snapshot().policy
    for (const id of selected) (id > 0 ? policy.privateUsers : policy.groups).push(id)
    const decisions = report.entries.map((e) => ({
      ...e,
      decision: ids.has(e.id)
        ? "import"
        : e.status === "present"
          ? "retain-approval"
          : "retain-denial",
    }))
    return this.store.save(
      policy,
      revision,
      actor,
      "chat.access.reconcile",
      "environment-access",
      () => {
        this.store.db
          .prepare("INSERT INTO access_reviews VALUES (?,?,?,?,?)")
          .run(fingerprint, revision + 1, actor, Date.now(), JSON.stringify(decisions))
      },
    )
  }
}
