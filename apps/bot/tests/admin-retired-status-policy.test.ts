import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { inherited, initialPolicy } from "@narumitw/sumire-policy"
import { afterEach, describe, expect, it } from "vitest"
import { RuntimeConfigAdmin } from "../src/admin/runtime-config.js"
import { AdminStore } from "../src/admin/store.js"

const directories: string[] = []
const stores = new Set<AdminStore>()
const encryptionKey = Buffer.alloc(32, 7).toString("base64")
const notifications = {
  enabled: true,
  providers: ["github"],
  chatIds: [-100],
  pollIntervalSeconds: 60,
  minimumImpact: "minor",
  componentSelections: { github: ["fixture-component"] },
  quietHours: { timeZone: "Asia/Taipei", start: "22:00", end: "07:00" },
  batchWindowSeconds: 300,
  chatOverrides: { "-100": { minimumImpact: "critical" } },
  notifyUpdates: true,
  notifyResolved: true,
  includeMaintenance: false,
}
const preservedTables = [
  "known_tools",
  "known_skills",
  "imports",
  "chats",
  "sessions",
  "passkeys",
  "passkey_setup",
  "passkey_challenges",
  "chat_access_requests",
  "access_reviews",
  "runtime_config",
  "mcp",
  "status_deliveries",
  "status_pending",
] as const

function open(file: string) {
  const store = new AdminStore(file, 42)
  stores.add(store)
  return store
}
function close(store: AdminStore) {
  stores.delete(store)
  store.close()
}
function settings(db: DatabaseSync) {
  return db
    .prepare("SELECT revision, applied, status, policy, epoch FROM settings WHERE id=1")
    .get()
}
function preserved(db: DatabaseSync) {
  return Object.fromEntries(
    preservedTables.map((name) => [name, db.prepare(`SELECT * FROM ${name}`).all()]),
  )
}
afterEach(() => {
  for (const store of stores) store.close()
  stores.clear()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function legacy(
  extra: Record<string, unknown> = { statusNotifications: notifications },
  version = 5,
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sumire-retired-status-"))
  directories.push(directory)
  const file = path.join(directory, "admin.sqlite")
  const store = open(file)
  new RuntimeConfigAdmin(store, encryptionKey).save(
    "GH_TOKEN",
    { revision: 1, kind: "secret", value: "fixture-secret" },
    "42",
  )
  const policy: Record<string, unknown> = {
    ...initialPolicy(),
    tools: ["read", "bash"],
    skills: ["fixture-skill"],
    privateUsers: [42],
    groups: [-100],
    defaults: { ...initialPolicy().defaults, tools: ["read"], skills: ["fixture-skill"] },
    chats: {
      "42": { ...inherited, enabled: true, tools: [] },
      "-100": { ...inherited, enabled: false },
    },
    githubNotifications: { allowedUsernames: ["fixture-author"] },
    ...extra,
  }
  const raw = JSON.stringify(policy, null, 2)
  store.db
    .prepare(
      "UPDATE settings SET revision=7, applied=7, epoch=11, status='applied', policy=? WHERE id=1",
    )
    .run(raw)
  store.db.exec(`PRAGMA user_version=${version}`)
  store.db.exec(`
    INSERT INTO known_tools VALUES ('read'), ('bash');
    INSERT INTO known_skills VALUES ('fixture-skill');
    INSERT INTO imports VALUES ('fixture', '{"retained":true}');
    INSERT INTO passkeys VALUES ('42', 'fixture-credential', X'01', 0, 'fixture-handle', 'singleDevice', 0);
    INSERT INTO passkey_setup VALUES ('42', 'fixture-setup', 'https://admin.example.test', 1);
    INSERT INTO passkey_challenges VALUES ('fixture-challenge', '42', 'register', 'fixture', 'fixture-setup', 'fixture-handle', 1);
    INSERT INTO chat_access_requests VALUES ('fixture-request', -200, 'group', 'Fixture request', 'https://admin.example.test', 1, 2);
    INSERT INTO access_reviews VALUES ('fixture-review', 7, '42', 1, '[{"id":-100,"decision":"retain-denial"}]');
    CREATE TABLE mcp (name TEXT PRIMARY KEY, config TEXT NOT NULL);
    INSERT INTO mcp VALUES ('fixture-server', '{"command":"fixture-command","enabled":false,"env":{"TOKEN":"fixture-mcp-secret"}}');
    CREATE TABLE status_deliveries (event_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
    INSERT INTO status_deliveries VALUES ('fixture-incident', 'acknowledged');
    CREATE TABLE status_pending (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    INSERT INTO status_pending VALUES ('fixture-pending', '{"retained":true}');
  `)
  store.observe(42, "private", "Fixture chat")
  store.observe(-100, "group", "Fixture group")
  const session = store.createSession("42")
  store.audit("42", "fixture", 7, "retained")
  const before = settings(store.db)
  const rows = preserved(store.db)
  const audit = store.listAudit(0)
  close(store)
  return { file, policy, raw, before, rows, audit, session }
}

describe("retired status-notification policy compatibility", () => {
  it("opens persisted feature settings before startup skill registration without discarding data", () => {
    const { file, policy, before, rows, audit, session } = legacy()
    const store = open(file)
    store.registerSkills(["fixture-skill"])
    store.registerTools(["read", "bash"])
    const { statusNotifications: _retired, ...activePolicy } = policy
    expect(store.snapshot()).toEqual({
      revision: 8,
      applied: 7,
      epoch: 12,
      status: "pending",
      policy: activePolicy,
    })
    expect(store.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 5 })
    expect(store.db.prepare("SELECT * FROM retired_status_notifications").all()).toEqual([before])
    expect(preserved(store.db)).toEqual(rows)
    expect(store.session(session.value)).toBeDefined()
    expect(new RuntimeConfigAdmin(store, encryptionKey).values.readSecret("GH_TOKEN")).toBe(
      "fixture-secret",
    )
    expect(store.listAudit(0)).toEqual([
      expect.objectContaining({
        actor: "system",
        operation: "settings.retire-status-notifications",
        revision: 8,
        outcome: "retired",
        target: "statusNotifications",
      }),
      ...audit,
    ])
    expect(JSON.stringify(store.snapshot())).not.toContain("statusNotifications")
    expect(JSON.stringify(store.listAudit(0))).not.toContain("fixture-component")
    expect(store.allows(42)).toBe(false)
    store.applied(7, true)
    expect(store.allows(42)).toBe(false)
    store.applied(8, true)
    expect(store.allows(42)).toBe(true)
    expect(store.allows(-100)).toBe(false)
    expect(store.allowsTool(42, "read")).toBe(false)
    expect(store.allows(99)).toBe(false)
  })

  it("is idempotent, preserves the archive on later saves, and rejects stale or retired-field writes", () => {
    const { file, before } = legacy()
    let store = open(file)
    const migrated = store.snapshot()
    const audit = store.listAudit(0)
    close(store)
    store = open(file)
    expect(store.snapshot()).toEqual(migrated)
    expect(store.listAudit(0)).toEqual(audit)
    expect(() => store.save(migrated.policy, 7, "42")).toThrow("Settings changed")
    expect(() =>
      store.save({ ...migrated.policy, statusNotifications: notifications }, 8, "42"),
    ).toThrow()
    expect(store.snapshot()).toEqual(migrated)
    store.save(migrated.policy, 8, "42")
    close(store)
    store = open(file)
    expect(store.snapshot()).toMatchObject({ revision: 9, epoch: 13, status: "pending" })
    expect(store.db.prepare("SELECT * FROM retired_status_notifications").all()).toEqual([before])
  })

  it("composes atomically with the older GitHub recipient migration", () => {
    const { file, before, rows } = legacy(
      { statusNotifications: notifications, githubNotifications: { allowedUserIds: [42] } },
      4,
    )
    const store = open(file)
    expect(store.snapshot()).toMatchObject({
      revision: 9,
      applied: 7,
      epoch: 13,
      status: "pending",
      policy: { githubNotifications: { allowedUsernames: [] } },
    })
    expect(store.db.prepare("SELECT * FROM retired_status_notifications").all()).toEqual([before])
    expect(preserved(store.db)).toEqual(rows)
  })

  it.each([null, false, "opaque retired value", { unsupportedRetiredOption: true }])(
    "archives rather than interprets a retired value: %j",
    (statusNotifications) => {
      const { file, before } = legacy({ statusNotifications })
      const store = open(file)
      expect(store.snapshot().policy).not.toHaveProperty("statusNotifications")
      expect(store.db.prepare("SELECT * FROM retired_status_notifications").all()).toEqual([before])
    },
  )

  it.each([
    { statusNotifications: notifications, unexpected: true },
    { statusNotifications: notifications, privateUsers: ["42"] },
    { statusNotifications: notifications, defaults: { ...inherited, unexpected: true } },
    { statusNotifications: notifications, githubNotifications: { allowedUserIds: ["42"] } },
  ])(
    "rolls back the archive, settings, metadata, and audit for invalid active settings: %j",
    (extra) => {
      const { file, before, rows, audit } = legacy(extra, 4)
      expect(() => open(file)).toThrow()
      const db = new DatabaseSync(file)
      try {
        expect(settings(db)).toEqual(before)
        expect(preserved(db)).toEqual(rows)
        expect(db.prepare("SELECT * FROM audit ORDER BY id DESC").all()).toEqual(audit)
        expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 })
        expect(
          db
            .prepare("SELECT name FROM sqlite_master WHERE name='retired_status_notifications'")
            .get(),
        ).toBeUndefined()
      } finally {
        db.close()
      }
    },
  )

  it("does not normalize unrelated stored values while retiring the field", () => {
    const { file, policy } = legacy({
      statusNotifications: notifications,
      githubNotifications: { allowedUsernames: ["Fixture-Author"] },
    })
    const store = open(file)
    const { statusNotifications: _retired, ...activePolicy } = policy
    expect(JSON.parse(String(settings(store.db)?.policy))).toEqual(activePolicy)
    expect(store.snapshot().policy.githubNotifications.allowedUsernames).toEqual(["fixture-author"])
  })

  it.each([
    "{",
    "null",
    "[]",
    JSON.stringify({ ...initialPolicy(), unexpected: true }),
    JSON.stringify({
      ...initialPolicy(),
      privateUsers: ["42"],
      statusNotifications: notifications,
    }),
  ])("rejects malformed version-5 data before committing startup: %s", (raw) => {
    const { file } = legacy()
    let db = new DatabaseSync(file)
    db.prepare("UPDATE settings SET policy=? WHERE id=1").run(raw)
    const before = settings(db)
    db.close()
    expect(() => open(file)).toThrow()
    db = new DatabaseSync(file)
    try {
      expect(settings(db)).toEqual(before)
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 5 })
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE name='retired_status_notifications'")
          .get(),
      ).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it("rolls back an archive failure without overwriting a prior archive", () => {
    const { file, before } = legacy()
    let db = new DatabaseSync(file)
    db.exec(`
      CREATE TABLE retired_status_notifications (revision INTEGER PRIMARY KEY, applied INTEGER NOT NULL, status TEXT NOT NULL, policy TEXT NOT NULL, epoch INTEGER NOT NULL);
      INSERT INTO retired_status_notifications VALUES (7, 7, 'applied', 'retained archive', 11);
    `)
    db.close()
    expect(() => open(file)).toThrow()
    db = new DatabaseSync(file)
    try {
      expect(settings(db)).toEqual(before)
      expect(db.prepare("SELECT policy FROM retired_status_notifications").get()?.policy).toBe(
        "retained archive",
      )
    } finally {
      db.close()
    }
  })

  it("rolls back the archive if updating active settings fails", () => {
    const { file, before, audit } = legacy()
    let db = new DatabaseSync(file)
    db.exec(
      "CREATE TRIGGER reject_retirement BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT,'fixture'); END",
    )
    db.close()
    expect(() => open(file)).toThrow("fixture")
    db = new DatabaseSync(file)
    try {
      expect(settings(db)).toEqual(before)
      expect(db.prepare("SELECT * FROM audit ORDER BY id DESC").all()).toEqual(audit)
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE name='retired_status_notifications'")
          .get(),
      ).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it("does not rewrite or archive current policy without the retired field", () => {
    const { file, before, rows, audit } = legacy({})
    const store = open(file)
    expect(settings(store.db)).toEqual(before)
    expect(preserved(store.db)).toEqual(rows)
    expect(store.listAudit(0)).toEqual(audit)
    expect(
      store.db
        .prepare("SELECT name FROM sqlite_master WHERE name='retired_status_notifications'")
        .get(),
    ).toBeUndefined()
  })
})
