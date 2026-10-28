import { randomBytes } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import { encrypt } from "../src/crypto.js"
import {
  initializeRuntimeConfigStorage,
  RuntimeConfigError,
  RuntimeConfigStore,
} from "../src/index.js"

const key = randomBytes(32).toString("hex")
const metadata = { updatedAt: 123, revision: 2 }
const databases: DatabaseSync[] = []
function fixture(master: string | undefined = key) {
  const db = new DatabaseSync(":memory:")
  databases.push(db)
  initializeRuntimeConfigStorage(db)
  return { db, store: new RuntimeConfigStore(db, master) }
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

describe("runtime configuration storage", () => {
  it("preserves literal strings and exposes no secret payload in metadata or database plaintext", () => {
    const { db, store } = fixture()
    const value = `  synthetic-secret\n\${NOT_EXPANDED}\u0000終  `
    store.setSecret("SERVICE_KEY", value, metadata)
    store.setVariable("LITERAL", value, metadata)
    expect(store.readSecret("SERVICE_KEY")).toBe(value)
    expect(store.readVariable("LITERAL")).toBe(value)
    expect(store.readVariable("SERVICE_KEY")).toBeUndefined()
    expect(store.readSecret("LITERAL")).toBeUndefined()
    const secret = store.listMetadata().find((entry) => entry.kind === "secret")
    expect(secret).toEqual({ name: "SERVICE_KEY", kind: "secret", configured: true, ...metadata })
    const payload = db.prepare("SELECT payload FROM runtime_config WHERE name='SERVICE_KEY'").get()
      ?.payload as string
    expect(payload).not.toContain("synthetic-secret")
    expect(db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 0 })
    expect(new RuntimeConfigStore(db, key).readSecret("SERVICE_KEY")).toBe(value)
    store.setSecret("SERVICE_KEY", value, metadata)
    expect(
      db.prepare("SELECT payload FROM runtime_config WHERE name='SERVICE_KEY'").get()?.payload,
    ).not.toBe(payload)
  })
  it.each([
    "BOT_TOKEN",
    "BOT_ADMIN_ID",
    "LOGFIRE_TOKEN",
    "ENCRYPTION_KEY",
    "ADMIN_ORIGIN",
    "",
    "lower",
    "A-B",
    "A".repeat(129),
  ])("rejects invalid or reserved name %s", (name) => {
    const { store } = fixture()
    expect(() => store.setVariable(name, "literal", metadata)).toThrow(RuntimeConfigError)
    expect(store.listMetadata()).toEqual([])
  })
  it.each(["secret", "variable"] as const)(
    "permits cleanup of a legacy %s whose name is now reserved",
    (kind) => {
      const { db, store } = fixture()
      const payload =
        kind === "secret"
          ? encrypt(Buffer.from(key, "hex"), "ENCRYPTION_KEY", "legacy-value")
          : "legacy-value"
      db.prepare("INSERT INTO runtime_config VALUES (?,?,?,?,?)").run(
        "ENCRYPTION_KEY",
        kind,
        payload,
        1,
        1,
      )
      expect(() => store.setVariable("ENCRYPTION_KEY", "replacement", metadata)).toThrow(
        RuntimeConfigError,
      )
      expect(() => store.setSecret("ENCRYPTION_KEY", "replacement", metadata)).toThrow(
        RuntimeConfigError,
      )
      store.delete("ENCRYPTION_KEY")
      expect(store.listMetadata()).toEqual([])
    },
  )
  it("enforces UTF-8 byte limits, kind separation, exact strings, and nonempty secrets", () => {
    const { store } = fixture()
    store.setVariable("EMPTY", "", metadata)
    store.setSecret("KEY", "x".repeat(8192), metadata)
    expect(() => store.setSecret("NO", "", metadata)).toThrow(RuntimeConfigError)
    expect(() => store.setVariable("BIG", "終".repeat(2731), metadata)).toThrow(RuntimeConfigError)
    expect(() => store.setSecret("INVALID_UTF8", "\ud800", metadata)).toThrow(RuntimeConfigError)
    expect(() => store.setVariable("KEY", "disclose", metadata)).toThrow("Delete")
    expect(() => store.setSecret("EMPTY", "secret", metadata)).toThrow("Delete")
    store.delete("KEY")
    store.setVariable("KEY", "now explicit", metadata)
    expect(store.readVariable("KEY")).toBe("now explicit")
  })
  it("bounds new entries but permits replacement at capacity", () => {
    const { store } = fixture()
    for (let n = 0; n < 256; n++) store.setVariable(`V_${n}`, "", metadata)
    expect(() => store.setVariable("OVER", "", metadata)).toThrow("256")
    store.setVariable("V_0", "replacement", metadata)
    expect(store.listMetadata()).toHaveLength(256)
  })
  it.each([
    undefined,
    "",
    "not a key",
    Buffer.alloc(31).toString("base64"),
    "0".repeat(63),
    "0".repeat(65),
    "g".repeat(64),
    `0x${key}`,
    `${key}\n`,
  ])("permits variables without a valid 32-byte master key (%s)", (master) => {
    const { db } = fixture()
    const store = new RuntimeConfigStore(db, master)
    expect(store.secretStatus).toBe("unavailable")
    store.setVariable("VISIBLE", "literal", metadata)
    expect(store.readVariable("VISIBLE")).toBe("literal")
    expect(() => store.setSecret("KEY", "synthetic", metadata)).toThrow("unavailable")
  })
  it("opens existing Base64 ciphertext with the same hex key without re-encryption", () => {
    const base64 = Buffer.from(key, "hex").toString("base64")
    const { db, store } = fixture(base64)
    store.setSecret("KEY", "legacy-secret-fixture", metadata)
    const original = db
      .prepare("SELECT payload FROM runtime_config WHERE name='KEY'")
      .get()?.payload
    const reopened = new RuntimeConfigStore(db, key)
    expect(reopened.secretStatus).toBe("ready")
    expect(reopened.readSecret("KEY")).toBe("legacy-secret-fixture")
    expect(db.prepare("SELECT payload FROM runtime_config WHERE name='KEY'").get()?.payload).toBe(
      original,
    )
    reopened.setSecret("KEY", "updated-secret-fixture", metadata)
    expect(new RuntimeConfigStore(db, base64).readSecret("KEY")).toBe("updated-secret-fixture")
  })
  it("locks a wrong key without leaking crypto details and permits variable changes", () => {
    const { db, store } = fixture()
    store.setSecret("KEY", "synthetic", metadata)
    const wrong = new RuntimeConfigStore(db, randomBytes(32).toString("base64"))
    expect(wrong.secretStatus).toBe("locked")
    expect(wrong.readSecret("KEY")).toBeUndefined()
    expect(() => wrong.setSecret("NEW", "synthetic", metadata)).toThrow("Secret storage is locked")
    expect(() => wrong.delete("KEY")).toThrow("locked")
    wrong.setVariable("LITERAL", "available", metadata)
    expect(new RuntimeConfigStore(db, key).readSecret("KEY")).toBe("synthetic")
  })
  it.each(["ciphertext", "nonce", "tag", "version", "name"])(
    "rejects tampered %s before any secret write",
    (field) => {
      const { db, store } = fixture()
      store.setSecret("KEY", "synthetic", metadata)
      const envelope = JSON.parse(
        db.prepare("SELECT payload FROM runtime_config").get()?.payload as string,
      )
      if (field === "name") db.prepare("UPDATE runtime_config SET name='MOVED'").run()
      else {
        envelope[field] =
          field === "version"
            ? 2
            : Buffer.alloc(field === "nonce" ? 12 : field === "tag" ? 16 : 9).toString("base64")
        db.prepare("UPDATE runtime_config SET payload=?").run(JSON.stringify(envelope))
      }
      expect(() => store.setSecret("NEW", "must-not-write", metadata)).toThrow("locked")
      expect(store.readSecret("KEY")).toBeUndefined()
      expect(store.listMetadata()).toHaveLength(1)
      expect(new RuntimeConfigStore(db, key).secretStatus).toBe("locked")
    },
  )
  it("participates in caller rollback without nested transactions", () => {
    const { db, store } = fixture()
    db.exec("BEGIN IMMEDIATE")
    store.setSecret("KEY", "synthetic", metadata)
    store.setVariable("VALUE", "literal", metadata)
    db.exec("ROLLBACK")
    expect(store.listMetadata()).toEqual([])
    store.setVariable("VALUE", "saved", metadata)
    db.exec("BEGIN IMMEDIATE")
    store.delete("VALUE")
    db.exec("ROLLBACK")
    expect(store.readVariable("VALUE")).toBe("saved")
  })
})
