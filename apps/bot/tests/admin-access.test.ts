import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { inherited } from "@narumitw/sumire-policy"
import { afterEach, expect, it, vi } from "vitest"
import { ChatAccess } from "../src/admin/access.js"
import { TestAdminStore as AdminStore } from "./helpers/admin-store.js"

const origin = "https://admin.example.test"
const cleanup: (() => void)[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const close of cleanup.splice(0).reverse()) close()
})
function fixture(ids = [42]) {
  const root = mkdtempSync(path.join(os.tmpdir(), "sumire-access-"))
  const file = path.join(root, "admin.sqlite")
  const store = new AdminStore(file, new Set(ids), 42)
  cleanup.push(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { store, access: new ChatAccess(store), file }
}
function issue(access: ChatAccess, id = -100, now = Date.now()) {
  const result = access.issue(
    { id, type: id < 0 ? "supergroup" : "private", name: "<untrusted>" },
    origin,
    now,
  )
  if (result.approved) throw new Error("Expected request")
  return new URLSearchParams(new URL(result.url).hash.slice(1)).get("allow") as string
}
it("persists hash-only bound metadata and upgrades version 2 without changing policy or sessions", () => {
  const { store, access, file } = fixture()
  const token = issue(access)
  const before = store.snapshot()
  const session = store.createSession("42")
  store.db.exec("PRAGMA user_version=2")
  const reopened = new AdminStore(file, new Set([999]), 42)
  try {
    expect(reopened.snapshot()).toEqual(before)
    expect(reopened.session(session.value)).toBeDefined()
    expect(new ChatAccess(reopened).resolve(token, origin)).toMatchObject({
      id: -100,
      name: "<untrusted>",
      type: "supergroup",
    })
    expect(
      JSON.stringify(store.db.prepare("SELECT * FROM chat_access_requests").all()),
    ).not.toContain(token)
  } finally {
    reopened.close()
  }
})
it("bounds issuance, replaces only after cooldown, expires, and binds origin", () => {
  const { store, access } = fixture()
  const now = Date.now()
  const first = issue(access, -100, now)
  expect(first).toMatch(/^[a-f0-9]{64}$/)
  expect(() => issue(access, -100, now + 59999)).toThrow("one minute")
  const next = issue(access, -100, now + 60000)
  expect(() => access.resolve(first, origin, now + 60000)).toThrow("no longer valid")
  expect(() => access.resolve(next, "https://other.example", now + 60000)).toThrow()
  expect(() => access.resolve(next, origin, now + 960000)).toThrow()
  store.db.exec("BEGIN")
  try {
    for (let id = -101; id >= -1099; id--) issue(access, id, now + 60000)
  } finally {
    store.db.exec("COMMIT")
  }
  expect(() => issue(access, -1100, now + 60000)).toThrow("Too many")
  expect(issue(access, -1100, now + 960000)).toMatch(/^[a-f0-9]{64}$/)
  expect(store.db.prepare("SELECT COUNT(*) AS n FROM chat_access_requests").get()).toMatchObject({
    n: 1,
  })
})
it("rejects invalid targets and returns existing approval without another request", () => {
  const { store, access } = fixture()
  expect(access.issue({ id: 42, type: "private", name: "Owner" }, origin)).toEqual({
    approved: true,
  })
  for (const id of [0, Number.MAX_SAFE_INTEGER + 1, -1])
    expect(() => access.issue({ id, type: "private", name: "x" }, origin)).toThrow("Invalid chat")
  expect(() => access.issue({ id: -1, type: "channel", name: "x" }, origin)).toThrow()
  expect(store.db.prepare("SELECT * FROM chat_access_requests").all()).toHaveLength(0)
})
it("atomically approves exactly one chat, preserves selections, and rejects replay after revocation", () => {
  const { store, access } = fixture()
  const policy = store.snapshot().policy
  policy.chats["-100"] = { ...inherited, enabled: false, tools: [] }
  store.save(policy, 1, "42")
  const token = issue(access)
  const before = store.snapshot()
  expect(() => access.approve(token, origin, 1, "42")).toThrow("Settings changed")
  expect(access.resolve(token, origin).id).toBe(-100)
  access.approve(token, origin, 2, "42")
  expect(store.snapshot()).toMatchObject({ revision: 3, status: "pending" })
  expect(store.allows(-100)).toBe(false)
  expect(store.snapshot().policy).toEqual({
    ...before.policy,
    groups: [-100],
    chats: { "-100": { ...before.policy.chats["-100"], enabled: true } },
  })
  store.applied(3, true)
  expect(store.allows(-100)).toBe(true)
  expect(store.allowsTool(-100, "bash")).toBe(false)
  expect(store.allows(-200)).toBe(false)
  const revoked = store.snapshot().policy
  revoked.groups = []
  store.save(revoked, 3, "42")
  expect(() => access.approve(token, origin, 4, "42")).toThrow("no longer valid")
  expect(store.snapshot().revision).toBe(4)
  expect(JSON.stringify(store.listAudit(0))).not.toContain(token)
})
it("observes already-approved requests without policy changes and never replays stale approval metadata", () => {
  const { store, access } = fixture()
  const before = store.snapshot()
  access.issue({ id: 42, type: "private", name: "Full Private Name" }, origin)
  expect(store.snapshot()).toEqual(before)
  expect(store.listChats(0)).toContainEqual({ id: 42, type: "private", name: "Full Private Name" })
  const token = issue(access)
  store.observe(-100, "channel", "Newer observation")
  const reopened = new AdminStore(store.file, new Set(), 42)
  try {
    new ChatAccess(reopened).approve(token, origin, before.revision, "42")
    expect(reopened.listChats(0)).toContainEqual({
      id: -100,
      type: "channel",
      name: "Newer observation",
    })
    expect(reopened.snapshot().policy.groups).toContain(-100)
  } finally {
    reopened.close()
  }
})

it("retains metadata from a legacy pending approval only when the directory row is missing", () => {
  const { store, access } = fixture()
  const token = issue(access)
  store.db.prepare("DELETE FROM chats WHERE id=?").run(-100)
  access.approve(token, origin, store.snapshot().revision, "42")
  expect(store.listChats(0)).toContainEqual({ id: -100, type: "supergroup", name: "<untrusted>" })
  expect(store.snapshot().policy.groups).toContain(-100)
})

it("rolls back consumption, revision, and audit if persistence fails", () => {
  const { store, access } = fixture()
  const token = issue(access)
  store.db.exec(
    "CREATE TRIGGER fail_access BEFORE DELETE ON chat_access_requests BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
  )
  expect(() => access.approve(token, origin, 1, "42")).toThrow("fixture failure")
  expect(store.snapshot().revision).toBe(1)
  expect(store.listAudit(0)).toHaveLength(0)
  expect(access.resolve(token, origin).id).toBe(-100)
})
it("rolls back approval if the request expires between resolution and commit", () => {
  const { store, access } = fixture()
  const now = Date.now()
  const token = issue(access, -100, now)
  vi.spyOn(Date, "now")
    .mockReturnValueOnce(now + 899999)
    .mockReturnValue(now + 900000)
  try {
    expect(() => access.approve(token, origin, 1, "42")).toThrow("no longer valid")
    expect(store.snapshot().revision).toBe(1)
    expect(store.listAudit(0)).toHaveLength(0)
    expect(store.db.prepare("SELECT * FROM chat_access_requests").all()).toHaveLength(1)
  } finally {
    vi.restoreAllMocks()
  }
})
it("creates new tables on version 2 state without changing credentials or policy", () => {
  const { store, file } = fixture()
  const before = store.snapshot()
  store.db
    .prepare("INSERT INTO passkeys VALUES (?,?,?,?,?,?,?)")
    .run("42", "fixture", Buffer.from("public-key"), 0, "user", "singleDevice", 0)
  store.db.exec("DROP TABLE chat_access_requests; DROP TABLE access_reviews; PRAGMA user_version=2")
  const reopened = new AdminStore(file, new Set([99]), 42)
  try {
    expect(reopened.snapshot()).toEqual(before)
    expect(reopened.db.prepare("SELECT id FROM passkeys").get()).toMatchObject({ id: "fixture" })
    expect(reopened.db.prepare("SELECT * FROM chat_access_requests").all()).toEqual([])
    expect(reopened.db.prepare("SELECT * FROM access_reviews").all()).toEqual([])
  } finally {
    reopened.close()
  }
})
it("does not consume requests when policy limits fail", () => {
  const { store, access } = fixture()
  const policy = store.snapshot().policy
  policy.groups = Array.from({ length: 1000 }, (_, i) => -i - 200)
  store.save(policy, 1, "42")
  const token = issue(access)
  expect(() => access.approve(token, origin, 2, "42")).toThrow()
  expect(access.resolve(token, origin).id).toBe(-100)
  expect(store.snapshot().revision).toBe(2)
})
