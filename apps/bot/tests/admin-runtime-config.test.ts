import { randomBytes } from "node:crypto"
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { backup } from "node:sqlite"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { RuntimeConfigAdmin } from "../src/admin/runtime-config.js"
import { AdminStore } from "../src/admin/store.js"

const key = randomBytes(32).toString("base64")
let directory: string
let store: AdminStore
let runtime: RuntimeConfigAdmin
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "sumire-runtime-config-"))
  store = new AdminStore(path.join(directory, "admin.sqlite"), 42)
  store.applied(1, true)
  runtime = new RuntimeConfigAdmin(store, key)
})
afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})
const put = (name: string, value: string, kind: "secret" | "variable" = "secret") =>
  runtime.save(name, { revision: store.snapshot().revision, kind, value }, "42")

describe("runtime configuration administration", () => {
  it("gates secrets on the complete applied revision; variables remain literal", () => {
    put("KEY", "synthetic-secret")
    expect(runtime.values.readSecret("KEY")).toBe("synthetic-secret")
    expect(runtime.readSecret("KEY")).toBeUndefined()
    store.applied(store.snapshot().revision, true)
    expect(runtime.readSecret("KEY")).toBe("synthetic-secret")
    put("NODE_OPTIONS", `literal \${KEY}`, "variable")
    expect(runtime.readSecret("KEY")).toBeUndefined()
    expect(runtime.readVariable("NODE_OPTIONS")).toBe(`literal \${KEY}`)
    store.applied(store.snapshot().revision, false)
    expect(runtime.readSecret("KEY")).toBeUndefined()
    expect(JSON.stringify(runtime.snapshot())).not.toContain("synthetic-secret")
    expect(JSON.stringify(store.listAudit(0))).not.toContain("synthetic-secret")
    expect(store.listAudit(0)).toContainEqual(
      expect.objectContaining({
        operation: "runtime-config.secret.set",
        target: "KEY",
        actor: "42",
      }),
    )
  })
  it("adds schema v4 without changing v3 settings, sessions, imports or audit", () => {
    const before = store.snapshot()
    const session = store.createSession("42")
    store.db.prepare("INSERT INTO imports VALUES ('fixture',?)").run('{"imported":1}')
    const audits = store.listAudit(0)
    store.db.exec("DROP TABLE runtime_config; PRAGMA user_version=3")
    chmodSync(directory, 0o755)
    chmodSync(store.file, 0o644)
    const file = store.file
    store.close()
    store = new AdminStore(file, 42)
    runtime = new RuntimeConfigAdmin(store, key)
    expect(store.snapshot()).toEqual(before)
    expect(store.session(session.value)).toBeDefined()
    expect(store.listAudit(0)).toEqual(audits)
    expect(store.db.prepare("SELECT report FROM imports WHERE name='fixture'").get()?.report).toBe(
      '{"imported":1}',
    )
    expect(store.db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 4 })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(runtime.snapshot().entries).toEqual([])
  })
  it("rolls back entries, revisions and audit on persistence errors or stale revision", () => {
    const before = store.snapshot()
    const audits = store.listAudit(0)
    expect(() => put("ADMIN_KEY", "synthetic")).toThrow("Invalid runtime")
    expect(store.snapshot()).toEqual(before)
    expect(store.listAudit(0)).toEqual(audits)
    expect(() => runtime.remove("MISSING", before.revision, "42")).toThrow("not found")
    expect(store.snapshot()).toEqual(before)
    expect(store.listAudit(0)).toEqual(audits)
    store.db.exec(
      `CREATE TRIGGER reject_runtime BEFORE INSERT ON runtime_config BEGIN SELECT RAISE(ABORT,'fixture'); END`,
    )
    expect(() => put("KEY", "synthetic")).toThrow()
    expect(store.snapshot()).toEqual(before)
    expect(store.listAudit(0)).toEqual(audits)
    store.db.exec("DROP TRIGGER reject_runtime")
    put("KEY", "original")
    expect(() =>
      runtime.save("KEY", { revision: before.revision, kind: "secret", value: "conflict" }, "42"),
    ).toThrow("Settings changed")
    expect(runtime.values.readSecret("KEY")).toBe("original")
    const saved = store.snapshot()
    expect(() => put("KEY", "disclose", "variable")).toThrow("Delete")
    expect(store.snapshot()).toEqual(saved)
  })
  it("imports only two eligible absent names once; deletion never restores an environment value", () => {
    put("MORSEL_API_KEY", "explicit-variable", "variable")
    runtime.importLegacy({
      FIRECRAWL_API_KEY: "  synthetic-import\n",
      MORSEL_API_KEY: "must-not-overwrite",
      UNRELATED: "must-not-import",
    })
    expect(runtime.values.readSecret("FIRECRAWL_API_KEY")).toBe("  synthetic-import\n")
    expect(runtime.readVariable("MORSEL_API_KEY")).toBe("explicit-variable")
    expect(runtime.snapshot().entries).toHaveLength(2)
    const report = store.db.prepare("SELECT report FROM imports WHERE name='runtime-config'").get()
      ?.report as string
    expect(JSON.parse(report)).toEqual({ imported: 1, skipped: 0 })
    runtime.remove("FIRECRAWL_API_KEY", store.snapshot().revision, "42")
    runtime.importLegacy({ FIRECRAWL_API_KEY: "resurrection" })
    expect(runtime.values.readSecret("FIRECRAWL_API_KEY")).toBeUndefined()
    expect(runtime.snapshot().entries).toHaveLength(1)
    const file = store.file
    store.close()
    store = new AdminStore(file, 42)
    runtime = new RuntimeConfigAdmin(store, key)
    runtime.importLegacy({ FIRECRAWL_API_KEY: "restart-resurrection" })
    expect(runtime.values.readSecret("FIRECRAWL_API_KEY")).toBeUndefined()
  })
  it("defers import while unavailable and repairs after variables were saved", () => {
    runtime = new RuntimeConfigAdmin(store)
    put("EXISTING", "literal", "variable")
    runtime.importLegacy({ FIRECRAWL_API_KEY: "synthetic" })
    expect(
      store.db.prepare("SELECT * FROM imports WHERE name='runtime-config'").get(),
    ).toBeUndefined()
    const file = store.file
    store.close()
    store = new AdminStore(file, 42)
    runtime = new RuntimeConfigAdmin(store, key)
    runtime.importLegacy({ FIRECRAWL_API_KEY: "synthetic" })
    expect(runtime.values.readSecret("FIRECRAWL_API_KEY")).toBe("synthetic")
    expect(runtime.readVariable("EXISTING")).toBe("literal")
    expect(
      store.db.prepare("SELECT * FROM imports WHERE name='runtime-config'").get(),
    ).toBeDefined()
  })
  it("defers wrong-key import and permits variables without creating mixed-key data", () => {
    put("EXISTING_KEY", "existing-secret")
    runtime = new RuntimeConfigAdmin(store, randomBytes(32).toString("base64"))
    expect(runtime.snapshot().secretStatus).toBe("locked")
    put("LITERAL", "available", "variable")
    const before = store.snapshot()
    expect(() => put("NEW_KEY", "new-secret")).toThrow("locked")
    runtime.importLegacy({ FIRECRAWL_API_KEY: "legacy" })
    expect(store.snapshot()).toEqual(before)
    expect(
      store.db.prepare("SELECT * FROM imports WHERE name='runtime-config'").get(),
    ).toBeUndefined()
    runtime = new RuntimeConfigAdmin(store, key)
    runtime.importLegacy({ FIRECRAWL_API_KEY: "legacy" })
    expect(runtime.values.readSecret("EXISTING_KEY")).toBe("existing-secret")
    expect(runtime.values.readSecret("FIRECRAWL_API_KEY")).toBe("legacy")
    expect(runtime.readVariable("LITERAL")).toBe("available")
  })
  it("authenticates all ciphertext before import and atomically rolls back marker with entries", () => {
    put("EXISTING_KEY", "existing-secret")
    store.db.exec("UPDATE runtime_config SET payload='{}'")
    const before = store.snapshot()
    runtime.importLegacy({ FIRECRAWL_API_KEY: "legacy" })
    expect(store.snapshot()).toEqual(before)
    expect(runtime.snapshot().secretStatus).toBe("locked")
    expect(
      store.db.prepare("SELECT * FROM imports WHERE name='runtime-config'").get(),
    ).toBeUndefined()
  })
  it("restores a matching key and database and limits a stopped-service reset to encrypted rows", async () => {
    const sentinel = "synthetic-restore-secret-not-plaintext"
    put("RESTORE_KEY", sentinel)
    put("KEEP_VARIABLE", "retained literal", "variable")
    runtime.importLegacy({})
    store.applied(store.snapshot().revision, true)
    const session = store.createSession("42")
    store.db
      .prepare("INSERT INTO passkeys VALUES (?,?,?,?,?,?,?)")
      .run(
        "42",
        "fixture-passkey",
        Buffer.from("fixture-public-key"),
        0,
        "handle",
        "singleDevice",
        0,
      )
    const before = store.snapshot()
    const audits = store.listAudit(0)
    const snapshotFile = path.join(directory, "snapshot.sqlite")
    await backup(store.db, snapshotFile)
    expect(readFileSync(snapshotFile).includes(Buffer.from(sentinel))).toBe(false)
    runtime.remove("RESTORE_KEY", store.snapshot().revision, "42")
    put("KEEP_VARIABLE", "changed", "variable")
    const file = store.file
    store.close()
    copyFileSync(snapshotFile, file)
    store = new AdminStore(file, 42)
    expect(
      new RuntimeConfigAdmin(store, randomBytes(32).toString("base64")).snapshot().secretStatus,
    ).toBe("locked")
    runtime = new RuntimeConfigAdmin(store, key)
    expect(runtime.readSecret("RESTORE_KEY")).toBe(sentinel)
    expect(runtime.readVariable("KEEP_VARIABLE")).toBe("retained literal")
    expect(store.snapshot()).toEqual(before)
    expect(store.listAudit(0)).toEqual(audits)
    expect(store.session(session.value)).toBeDefined()
    // Simulate the trusted operator's stopped-service SQL reset, not an HTTP capability.
    store.db.exec("BEGIN IMMEDIATE; DELETE FROM runtime_config WHERE kind='secret'; COMMIT")
    runtime = new RuntimeConfigAdmin(store, randomBytes(32).toString("base64"))
    expect(runtime.snapshot().secretStatus).toBe("ready")
    runtime.importLegacy({ FIRECRAWL_API_KEY: "must-not-resurrect" })
    expect(runtime.snapshot().entries).toEqual([
      expect.objectContaining({ name: "KEEP_VARIABLE", value: "retained literal" }),
    ])
    expect(store.snapshot()).toEqual(before)
    expect(store.listAudit(0)).toEqual(audits)
    expect(store.session(session.value)).toBeDefined()
    expect(store.db.prepare("SELECT id FROM passkeys").get()?.id).toBe("fixture-passkey")
    put("REPLACEMENT_KEY", "new synthetic")
    expect(runtime.values.readSecret("REPLACEMENT_KEY")).toBe("new synthetic")
  })
  it("rolls back import entries and revision if marker persistence fails", () => {
    store.db.exec(
      `CREATE TRIGGER reject_import BEFORE INSERT ON imports BEGIN SELECT RAISE(ABORT,'fixture'); END`,
    )
    const before = store.snapshot()
    const audits = store.listAudit(0)
    expect(() => runtime.importLegacy({ FIRECRAWL_API_KEY: "legacy" })).toThrow()
    expect(store.snapshot()).toEqual(before)
    expect(store.listAudit(0)).toEqual(audits)
    expect(runtime.snapshot().entries).toEqual([])
  })
  it("records an empty import and rejects oversized legacy values without recording them", () => {
    runtime.importLegacy({ FIRECRAWL_API_KEY: "x".repeat(8193), MORSEL_API_KEY: "" })
    expect(runtime.snapshot().entries).toEqual([])
    expect(
      JSON.parse(
        store.db.prepare("SELECT report FROM imports WHERE name='runtime-config'").get()
          ?.report as string,
      ),
    ).toEqual({ imported: 0, skipped: 1 })
    runtime.importLegacy({ FIRECRAWL_API_KEY: "later" })
    expect(runtime.snapshot().entries).toEqual([])
  })
})

it("keeps GH_TOKEN under the general managed secret controls", () => {
  put("GH_TOKEN", "managed-github-secret-sentinel")
  expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
  store.applied(store.snapshot().revision, true)
  expect(runtime.readSecret("GH_TOKEN")).toBe("managed-github-secret-sentinel")
  expect(JSON.stringify(runtime.snapshot())).not.toContain("managed-github-secret-sentinel")
  expect(JSON.stringify(store.listAudit(0))).not.toContain("managed-github-secret-sentinel")
  expect(() => put("GH_TOKEN", "variable", "variable")).toThrow("Delete")
  runtime.remove("GH_TOKEN", store.snapshot().revision, "42")
  store.applied(store.snapshot().revision, true)
  expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
  // Generic runtime configuration does not impose a GitHub-specific token format.
  put("GH_TOKEN", "literal\nsecret")
  store.applied(store.snapshot().revision, true)
  expect(runtime.readSecret("GH_TOKEN")).toBe("literal\nsecret")
})

it("does not interpret legacy notification runtime names as recipient policy", () => {
  put("GITHUB_NOTIFICATIONS_ALLOWED_USER_IDS", "not an ID list", "variable")
  put("GITHUB_NOTIFICATIONS_TOKEN", "ordinary variable", "variable")
  expect(runtime.readVariable("GITHUB_NOTIFICATIONS_ALLOWED_USER_IDS")).toBe("not an ID list")
  expect(store.snapshot().policy.githubNotifications.allowedUserIds).toEqual([])
})
