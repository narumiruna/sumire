import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { ChatAccess } from "../src/admin/access.js"
import { inherited } from "../src/admin/policy.js"
import { AdminStore } from "../src/admin/store.js"

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
it("rolls back the reconciliation policy and audit when its review record cannot commit", () => {
  const { store, access } = fixture()
  const report = access.reconciliation()
  store.db.exec(
    "CREATE TRIGGER fail_review BEFORE INSERT ON access_reviews BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
  )
  expect(() => access.reconcile(report.fingerprint, [], 1, "42")).toThrow("fixture failure")
  expect(store.snapshot().revision).toBe(1)
  expect(store.listAudit(0)).toHaveLength(0)
  expect(access.reconciliation().review).toBeNull()
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
it("reconciles only explicitly selected missing IDs and preserves denials, history, and restart state", () => {
  const { store, file } = fixture([42, -100, 99])
  const policy = store.snapshot().policy
  policy.privateUsers = [42]
  policy.groups = []
  policy.chats["-100"] = { ...inherited, enabled: false }
  store.save(policy, 1, "42")
  const access = new ChatAccess(store)
  const report = access.reconciliation()
  expect(report.entries).toEqual([
    { id: -100, status: "disabled" },
    { id: 42, status: "present" },
    { id: 99, status: "missing" },
  ])
  expect(() => access.reconcile(report.fingerprint, [-100], 2, "42")).toThrow("missing")
  expect(() => access.reconcile(report.fingerprint, [99, 99], 2, "42")).toThrow("missing")
  expect(() => access.reconcile(report.fingerprint, [99], 1, "42")).toThrow("Settings changed")
  expect(access.reconciliation().review).toBeNull()
  access.reconcile(report.fingerprint, [99], 2, "42")
  const next = store.snapshot().policy
  expect(next.privateUsers).toEqual([42, 99])
  expect(next.groups).toEqual([])
  expect(next.chats).toEqual(policy.chats)
  next.privateUsers = [42]
  store.save(next, 3, "42")
  const reopened = new AdminStore(file, new Set([99, 42, -100]), 42)
  try {
    expect(new ChatAccess(reopened).reconciliation().review).toMatchObject({ revision: 3 })
    expect(() => new ChatAccess(reopened).reconcile(report.fingerprint, [99], 4, "42")).toThrow(
      "already been reviewed",
    )
    expect(reopened.snapshot().policy.privateUsers).toEqual([42])
  } finally {
    reopened.close()
  }
  const changed = new AdminStore(file, new Set([42, -100, 99, 100]), 42)
  try {
    const latest = new ChatAccess(changed)
    expect(latest.reconciliation().review).toBeNull()
    expect(() => latest.reconcile(report.fingerprint, [100], 4, "42")).toThrow(
      "Environment IDs changed",
    )
  } finally {
    changed.close()
  }
})
it("records retained missing denials and new database imports without automatic grants", () => {
  const { store, access } = fixture([42, -100])
  expect(access.reconciliation().entries.every((e) => e.status === "present")).toBe(true)
  const policy = store.snapshot().policy
  policy.groups = []
  store.save(policy, 1, "42")
  const report = access.reconciliation()
  access.reconcile(report.fingerprint, [], 2, "42")
  expect(JSON.stringify(access.reconciliation().review)).toContain("retain-denial")
  expect(store.snapshot().policy.groups).toEqual([])
})
