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
}
