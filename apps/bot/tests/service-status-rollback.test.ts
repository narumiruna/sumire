import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, it } from "vitest"
import { z } from "zod"
import { AdminStore } from "../src/admin/store.js"
import { StatusDeliveryState } from "../src/service-status/state.js"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// The previous binary rejects new fields. This fixture verifies backup restoration, not a
// dangerous conversion that could silently remove a component or quiet-hour restriction.
const legacyStatus = z
  .object({
    enabled: z.boolean(),
    providers: z.array(z.enum(["github", "openai", "claude", "cloudflare"])),
    chatIds: z.array(z.number()),
    pollIntervalSeconds: z.number(),
    minimumImpact: z.enum(["none", "minor", "major", "critical"]),
    notifyUpdates: z.boolean(),
    notifyResolved: z.boolean(),
    includeMaintenance: z.boolean(),
  })
  .strict()

it("restores a stopped pre-upgrade database without losing permissions or delivery checkpoints", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sumire-status-rollback-"))
  roots.push(root)
  const file = path.join(root, "admin.sqlite")
  const backup = path.join(root, "before-upgrade.sqlite")
  let store = new AdminStore(file, 42)
  try {
    const before = store.snapshot()
    before.policy.privateUsers = [42]
    before.policy.groups = [-100]
    const legacy = legacyStatus.parse({
      enabled: false,
      providers: ["github"],
      chatIds: [42, -100],
      pollIntervalSeconds: 60,
      minimumImpact: "minor",
      notifyUpdates: true,
      notifyResolved: true,
      includeMaintenance: false,
    })
    store.db.prepare("UPDATE settings SET policy=? WHERE id=1").run(
      JSON.stringify({
        ...before.policy,
        statusNotifications: legacy,
      }),
    )
    store.db.exec(`CREATE TABLE status_deliveries (
      chat_id INTEGER NOT NULL, provider TEXT NOT NULL, event_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, active INTEGER NOT NULL, maintenance INTEGER NOT NULL,
      touched INTEGER NOT NULL, PRIMARY KEY(chat_id,provider,event_id)
    )`)
    store.db
      .prepare("INSERT INTO status_deliveries VALUES (?,?,?,?,?,?,?)")
      .run(42, "github", "incident:synthetic", "acknowledged-fingerprint", 1, 0, Date.now())
    store.close()
    copyFileSync(file, backup)

    store = new AdminStore(file, 42)
    new StatusDeliveryState(store.db)
    const upgraded = store.snapshot()
    upgraded.policy.statusNotifications.enabled = true
    upgraded.policy.statusNotifications.quietHours = {
      timeZone: "Asia/Taipei",
      start: "22:00",
      end: "07:00",
    }
    upgraded.policy.statusNotifications.chatOverrides["42"] = { providers: ["openai"] }
    store.save(upgraded.policy, upgraded.revision, "42")
    const rawUpgraded = JSON.parse(
      String(store.db.prepare("SELECT policy FROM settings WHERE id=1").get()?.policy),
    )
    expect(legacyStatus.safeParse(rawUpgraded.statusNotifications).success).toBe(false)
    store.close()

    copyFileSync(backup, file)
    store = new AdminStore(file, 42)
    const rawRestored = JSON.parse(
      String(store.db.prepare("SELECT policy FROM settings WHERE id=1").get()?.policy),
    )
    expect(legacyStatus.parse(rawRestored.statusNotifications)).toEqual(legacy)
    expect(rawRestored.statusNotifications.enabled).toBe(false)
    expect(store.snapshot().policy.privateUsers).toEqual([42])
    expect(store.snapshot().policy.groups).toEqual([-100])
    expect(store.db.prepare("SELECT fingerprint FROM status_deliveries").get()).toMatchObject({
      fingerprint: "acknowledged-fingerprint",
    })
    expect(
      store.db.prepare("SELECT name FROM sqlite_master WHERE name='status_pending'").get(),
    ).toBeUndefined()
    const state = new StatusDeliveryState(store.db)
    expect(state.get(42, "github", "incident:synthetic")?.active).toBe(1)
    expect(state.pending()).toEqual([])
  } finally {
    store.close()
  }
})
