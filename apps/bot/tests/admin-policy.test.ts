import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { backup, DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { effectivePolicy, inherited, validateReferences } from "../src/admin/policy.js"
import { TestAdminStore as AdminStore, testPolicy as initialPolicy } from "./helpers/admin-store.js"

const directories: string[] = []
const stores: AdminStore[] = []
function store() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sumire-admin-"))
  directories.push(directory)
  const file = path.join(directory, "admin.sqlite")
  const s = new AdminStore(file, new Set([42, -100]), 42)
  stores.push(s)
  return { s, file }
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("admin policy and persistence", () => {
  it("restores a consistent backup without retaining later grants", async () => {
    const { s, file } = store()
    s.applied(1, true)
    const snapshotFile = `${file}.backup`
    await backup(s.db, snapshotFile)
    const policy = s.snapshot().policy
    policy.privateUsers.push(99)
    s.save(policy, 1, "42")
    s.applied(2, true)
    expect(s.allows(99)).toBe(true)
    const restored = new AdminStore(snapshotFile, new Set([99]), 42)
    try {
      expect(restored.snapshot().revision).toBe(1)
      expect(restored.allows(99)).toBe(false)
      expect(restored.allows(42)).toBe(true)
    } finally {
      restored.close()
    }
  })
  it("rolls back a failed initial migration without changing existing records", () => {
    const { file } = store()
    const broken = `${file}.migration`
    const source = new DatabaseSync(broken)
    source.exec("CREATE TABLE settings(id INTEGER PRIMARY KEY); INSERT INTO settings VALUES (7)")
    source.close()
    expect(() => new AdminStore(broken, new Set([42]), 42)).toThrow()
    const restored = new DatabaseSync(broken)
    try {
      expect(restored.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 0 })
      expect(restored.prepare("SELECT * FROM settings").all()).toMatchObject([{ id: 7 }])
      expect(
        restored.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),
      ).toMatchObject([{ name: "settings" }])
    } finally {
      restored.close()
    }
  })
  it("migrates Telegram state without changing policy and revokes only old sessions", () => {
    const { s, file } = store()
    const before = s.snapshot()
    const old = s.createSession("42")
    s.db.exec(
      "CREATE TABLE login(hash TEXT); INSERT INTO login VALUES ('old'); PRAGMA user_version=1",
    )
    const migrated = new AdminStore(file, new Set([99]), 42)
    try {
      expect(migrated.snapshot()).toEqual(before)
      expect(migrated.session(old.value)).toBeUndefined()
      expect(
        migrated.db.prepare("SELECT name FROM sqlite_master WHERE name='login'").get(),
      ).toBeUndefined()
      expect(migrated.db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 3 })
      const current = migrated.createSession("42")
      const reopened = new AdminStore(file, new Set(), 42)
      try {
        expect(reopened.session(current.value)).toBeDefined()
      } finally {
        reopened.close()
      }
    } finally {
      migrated.close()
    }
  })
  it("refuses a newer database schema instead of downgrading it", () => {
    const { file } = store()
    const future = `${file}.future`
    const db = new DatabaseSync(future)
    db.exec("PRAGMA user_version=4")
    db.close()
    expect(() => new AdminStore(future, new Set(), 42)).toThrow("newer")
  })
  it("imports access IDs once and denies unknown chats and capabilities", () => {
    const { s, file } = store()
    expect(s.allows(42)).toBe(false)
    s.applied(1, true)
    expect(s.allows(42)).toBe(true)
    expect(s.allows(-100)).toBe(true)
    expect(s.allows(-200)).toBe(false)
    expect(s.allowsTool(42, "bash")).toBe(false)
    const reopened = new AdminStore(file, new Set([777]), 42)
    expect(reopened.snapshot().policy.privateUsers).toEqual([42])
    reopened.close()
  })
  it("distinguishes inheritance and explicit empty selections within global ceilings", () => {
    const p = initialPolicy(new Set([42]))
    p.tools = ["read", "read_url_content"]
    p.defaults.tools = ["read_url_content"]
    expect(effectivePolicy(p, 42).tools).toEqual(["read_url_content"])
    p.chats["42"] = { ...inherited, enabled: true, tools: [] }
    expect(effectivePolicy(p, 42).tools).toEqual([])
    p.chats["42"].tools = ["bash"]
    expect(effectivePolicy(p, 42).tools).toEqual([])
    expect(() => validateReferences(p)).toThrow("global availability")
  })
  it("commits revisions and audit atomically and rejects stale writes", () => {
    const { s } = store()
    const p = s.snapshot().policy
    p.tools = ["read"]
    s.save(p, 1, "42")
    expect(s.snapshot()).toMatchObject({ revision: 2, applied: 0, status: "pending" })
    expect(() => s.save(p, 1, "42")).toThrow("Settings changed")
    expect(s.snapshot().revision).toBe(2)
    expect(s.listAudit(0)).toHaveLength(1)
    s.applied(1, true)
    expect(s.snapshot().status).toBe("pending")
    s.applied(2, false)
    expect(s.allows(42)).toBe(false)
    s.applied(2, true)
    expect(s.allows(42)).toBe(true)
  })
  it("rejects disabling a referenced provider without silently changing models", () => {
    const { s } = store()
    const policy = s.snapshot().policy
    policy.providers = [{ id: "fixture", enabled: true, models: [] }]
    policy.models = ["fixture/model"]
    policy.defaults.models = ["fixture/model"]
    policy.defaults.model = "fixture/model"
    s.save(policy, 1, "42")
    const provider = policy.providers[0]
    if (provider) provider.enabled = false
    expect(() => s.save(policy, 2, "42")).toThrow("Provider")
    expect(s.snapshot().revision).toBe(2)
    expect(s.snapshot().policy.defaults.model).toBe("fixture/model")
  })
  it("advances the authorization epoch for administration writes but not serialized model commands", () => {
    const { s } = store()
    const policy = s.snapshot().policy
    expect(s.snapshot().epoch).toBe(1)
    s.save(policy, 1, "42")
    expect(s.snapshot().epoch).toBe(2)
    s.save(policy, 2, "chat:42", "chat.model.update", "chat:42")
    expect(s.snapshot().epoch).toBe(2)
    expect(s.snapshot().revision).toBe(3)
  })
  it("rejects invalid references before changing persisted state", () => {
    const { s } = store()
    const p = s.snapshot().policy
    p.defaults.model = "openai/unknown"
    expect(() => s.save(p, 1, "42")).toThrow()
    expect(s.snapshot().revision).toBe(1)
    expect(s.listAudit(0)).toHaveLength(0)
  })
  it("requires both server and tool permission and denies pending and failed revisions", () => {
    const { s } = store()
    const p = s.snapshot().policy
    p.tools = ["mcp__one__read"]
    p.servers = ["one"]
    p.defaults.tools = [...p.tools]
    p.defaults.servers = [...p.servers]
    s.save(p, 1, "42")
    s.applied(2, true)
    expect(s.allowsTool(42, "mcp__one__read", "one")).toBe(true)
    expect(s.allowsTool(42, "mcp__one__read", "two")).toBe(false)
    p.servers = []
    p.defaults.servers = []
    s.save(p, 2, "42")
    expect(s.allowsTool(42, "mcp__one__read", "one")).toBe(false)
  })
  it("expires idle and absolute sessions, binds the administrator, and revokes logout", () => {
    const { s } = store()
    const session = s.createSession("42", 100000)
    expect(s.session(session.value, 100001)?.csrf).toBe(session.csrf)
    expect(s.session(session.value, 100001 + 30 * 60_000)).toBeUndefined()
    const other = s.createSession("43")
    expect(s.session(other.value)).toBeUndefined()
    const fresh = s.createSession("42")
    s.revoke(fresh.value)
    expect(s.session(fresh.value)).toBeUndefined()
    const absolute = s.createSession("42", 0)
    expect(s.session(absolute.value, 8 * 3600_000 + 1)).toBeUndefined()
  })
  it("bounds known chat inventory and does not grant access from observation", () => {
    const { s } = store()
    // Test the inventory limit without a disk commit for each observed chat.
    s.db.exec("BEGIN IMMEDIATE")
    try {
      for (let n = 1; n <= 1005; n++) s.observe(n, "private", "x".repeat(200))
      s.db.exec("COMMIT")
    } catch (error) {
      s.db.exec("ROLLBACK")
      throw error
    }
    expect(s.listChats(0)).toHaveLength(100)
    expect(s.listChats(900)).toHaveLength(100)
    expect(s.listChats(1000)).toHaveLength(0)
    expect(s.allows(1000)).toBe(false)
  })
})
