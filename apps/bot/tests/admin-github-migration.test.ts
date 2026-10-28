import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import { inherited, initialPolicy } from "@narumitw/sumire-policy"
import { afterEach, describe, expect, it } from "vitest"
import { RuntimeConfigAdmin } from "../src/admin/runtime-config.js"
import { AdminStore } from "../src/admin/store.js"

const encryptionKey = Buffer.alloc(32, 7).toString("base64")
const directories: string[] = []
const stores = new Set<AdminStore>()
const open = (file: string) => {
  const store = new AdminStore(file, 42)
  stores.add(store)
  return store
}
const close = (store: AdminStore) => {
  stores.delete(store)
  store.close()
}
afterEach(() => {
  for (const store of stores) store.close()
  stores.clear()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function legacy(githubNotifications: unknown) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sumire-github-migration-"))
  directories.push(directory)
  const file = path.join(directory, "admin.sqlite")
  const store = open(file)
  const runtime = new RuntimeConfigAdmin(store, encryptionKey)
  runtime.save("GH_TOKEN", { revision: 1, kind: "secret", value: "fixture-github-token" }, "42")
  runtime.save("FIXTURE", { revision: 2, kind: "variable", value: "retained variable" }, "42")
  const runtimeRows = store.db.prepare("SELECT * FROM runtime_config ORDER BY name").all()
  const policy = {
    ...initialPolicy(),
    tools: ["bash"],
    privateUsers: [42],
    defaults: { ...initialPolicy().defaults, tools: ["bash"] },
    chats: { "42": { ...inherited, enabled: true } },
    providers: [{ id: "fixture", enabled: true, models: [] }],
    githubNotifications,
  }
  const persisted = JSON.stringify(policy)
  store.db
    .prepare(
      "UPDATE settings SET revision=7, applied=7, epoch=11, status='applied', policy=? WHERE id=1",
    )
    .run(persisted)
  store.db.exec("PRAGMA user_version=4")
  const session = store.createSession("42")
  store.audit("42", "fixture", 7, "retained")
  store.db.prepare("INSERT INTO imports VALUES ('fixture',?)").run('{"retained":true}')
  const audit = store.listAudit(0)
  close(store)
  return { file, policy, persisted, session, audit, runtimeRows }
}

describe("admin schema v5 GitHub mention author migration", () => {
  it.each([{ ids: [] }, { ids: [42, 123456789, Number.MAX_SAFE_INTEGER] }])(
    "clears legacy Telegram IDs $ids and requires application of a new revision",
    ({ ids }) => {
      const { file, policy, session, audit, runtimeRows } = legacy({ allowedUserIds: ids })
      const store = open(file)
      expect(store.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 5 })
      expect(store.snapshot()).toEqual({
        revision: 8,
        applied: 7,
        epoch: 12,
        status: "pending",
        policy: { ...policy, githubNotifications: { allowedUsernames: [] } },
      })
      expect(store.allows(42)).toBe(false)
      expect(store.session(session.value)).toBeDefined()
      expect(store.listAudit(0)).toEqual(audit)
      expect(store.db.prepare("SELECT * FROM runtime_config ORDER BY name").all()).toEqual(
        runtimeRows,
      )
      const runtime = new RuntimeConfigAdmin(store, encryptionKey)
      expect(runtime.values.readSecret("GH_TOKEN")).toBe("fixture-github-token")
      expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
      expect(runtime.readVariable("FIXTURE")).toBe("retained variable")
      expect(
        store.db.prepare("SELECT report FROM imports WHERE name='fixture'").get()?.report,
      ).toBe('{"retained":true}')
      expect(
        JSON.parse(store.db.prepare("SELECT policy FROM settings").get()?.policy as string),
      ).toEqual({ ...policy, githubNotifications: { allowedUsernames: [] } })
      const migrated = store.snapshot()
      close(store)
      const reopened = open(file)
      expect(reopened.snapshot()).toEqual(migrated)
      expect(() => reopened.save(migrated.policy, 7, "42")).toThrow("Settings changed")
      reopened.applied(7, true)
      expect(reopened.snapshot().status).toBe("pending")
      reopened.applied(8, true)
      expect(reopened.allows(42)).toBe(true)
      expect(new RuntimeConfigAdmin(reopened, encryptionKey).readSecret("GH_TOKEN")).toBe(
        "fixture-github-token",
      )
    },
  )

  it("defaults missing GitHub settings to empty without changing the applied revision", () => {
    const { file, policy, persisted } = legacy(undefined)
    const store = open(file)
    expect(store.snapshot()).toEqual({
      revision: 7,
      applied: 7,
      epoch: 11,
      status: "applied",
      policy: { ...policy, githubNotifications: { allowedUsernames: [] } },
    })
    expect(store.db.prepare("SELECT policy FROM settings").get()?.policy).toBe(persisted)
    expect(store.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 5 })
  })

  it("preserves current username settings and normalizes them on parsing", () => {
    const { file } = legacy({ allowedUsernames: ["OctoCat", "Hubot"] })
    const store = open(file)
    expect(store.snapshot()).toMatchObject({
      revision: 7,
      applied: 7,
      epoch: 11,
      status: "applied",
      policy: { githubNotifications: { allowedUsernames: ["octocat", "hubot"] } },
    })
  })

  it.each(
    [
      null,
      [],
      {},
      { allowedUserIds: ["42"] },
      { allowedUserIds: [0] },
      { allowedUserIds: [-100] },
      { allowedUserIds: [1.5] },
      { allowedUserIds: [Number.MAX_SAFE_INTEGER + 1] },
      { allowedUserIds: [42, 42] },
      { allowedUserIds: Array.from({ length: 1001 }, (_, index) => index + 1) },
      { allowedUserIds: [], extra: true },
      { allowedUserIds: [42], allowedUsernames: ["octocat"] },
      { allowedUsernames: ["octocat", "OCTOCAT"] },
    ].map((notifications) => ({ notifications })),
  )(
    "rejects malformed settings $notifications and rolls back the migration",
    ({ notifications }) => {
      const { file, persisted } = legacy(notifications)
      expect(() => open(file)).toThrow()
      const db = new DatabaseSync(file)
      try {
        expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 })
        expect(
          db.prepare("SELECT revision, applied, epoch, status, policy FROM settings").get(),
        ).toEqual({
          revision: 7,
          applied: 7,
          epoch: 11,
          status: "applied",
          policy: persisted,
        })
      } finally {
        db.close()
      }
    },
  )

  it("rejects legacy fields on saves and persists only canonical lowercase usernames", () => {
    const { file } = legacy(undefined)
    const store = open(file)
    const before = store.snapshot()
    for (const githubNotifications of [
      { allowedUserIds: [] },
      { allowedUserIds: [42] },
      { allowedUserIds: [], allowedUsernames: [] },
      { allowedUsernames: ["octocat", "OCTOCAT"] },
    ]) {
      expect(() => store.save({ ...before.policy, githubNotifications }, 7, "42")).toThrow()
      expect(store.snapshot()).toEqual(before)
    }
    store.save(
      { ...before.policy, githubNotifications: { allowedUsernames: ["OctoCat"] } },
      7,
      "42",
    )
    expect(store.snapshot().policy.githubNotifications.allowedUsernames).toEqual(["octocat"])
    expect(
      JSON.parse(store.db.prepare("SELECT policy FROM settings").get()?.policy as string)
        .githubNotifications,
    ).toEqual({ allowedUsernames: ["octocat"] })
  })
})
