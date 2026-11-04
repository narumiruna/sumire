import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, it } from "vitest"
import { AdminStore } from "../src/admin/store.js"
import { StatusDeliveryState } from "../src/service-status/state.js"

const cleanup: Array<() => void> = []
const now = Date.parse("2030-01-31T12:00:00Z")
const retention = 30 * 24 * 3600_000

afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sumire-status-state-"))
  const file = path.join(directory, "admin.sqlite")
  let store = new AdminStore(file, 42)
  cleanup.push(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    get store() {
      return store
    },
    reopen() {
      store.close()
      store = new AdminStore(file, 42)
      return new StatusDeliveryState(store.db)
    },
  }
}

it("adds status storage without changing the administration schema or settings", () => {
  const f = fixture()
  const snapshot = f.store.snapshot()
  const version = f.store.db.prepare("PRAGMA user_version").get()
  f.store.db.prepare("INSERT INTO imports VALUES (?,?)").run("fixture", "preserved")
  const state = new StatusDeliveryState(f.store.db)
  new StatusDeliveryState(f.store.db)
  expect(state.active("github")).toEqual([])
  expect(f.store.snapshot()).toEqual(snapshot)
  expect(f.store.db.prepare("PRAGMA user_version").get()).toEqual(version)
  expect(f.store.db.prepare("SELECT report FROM imports WHERE name='fixture'").get()).toEqual({
    report: "preserved",
  })
})

it("stores independent chat, provider, and event checkpoints and replaces only one acknowledgement", () => {
  const f = fixture()
  const state = new StatusDeliveryState(f.store.db)
  state.acknowledge(101, "github", "incident:first", "first", true, false, now)
  state.acknowledge(-202, "github", "incident:first", "second-chat", true, false, now)
  state.acknowledge(101, "openai", "incident:first", "other-provider", true, false, now)
  state.acknowledge(101, "github", "maintenance:first", "maintenance", true, true, now)
  state.acknowledge(101, "github", "incident:first", "resolved", false, false, now + 1)

  expect(state.get(101, "github", "incident:first")).toEqual({
    chatId: 101,
    provider: "github",
    eventId: "incident:first",
    fingerprint: "resolved",
    active: 0,
    maintenance: 0,
  })
  expect(state.get(-202, "github", "incident:first")?.fingerprint).toBe("second-chat")
  expect(state.get(101, "openai", "incident:first")?.fingerprint).toBe("other-provider")
  expect(state.active("github")).toEqual([
    {
      chatId: -202,
      provider: "github",
      eventId: "incident:first",
      fingerprint: "second-chat",
      active: 1,
      maintenance: 0,
    },
    {
      chatId: 101,
      provider: "github",
      eventId: "maintenance:first",
      fingerprint: "maintenance",
      active: 1,
      maintenance: 1,
    },
  ])
  expect(state.get(999, "github", "incident:first")).toBeUndefined()
})

it("prunes removed subscriptions and expired inactive records but retains old active incidents", () => {
  const f = fixture()
  const state = new StatusDeliveryState(f.store.db)
  state.acknowledge(101, "github", "incident:active", "active", true, false, now - retention - 1)
  state.acknowledge(101, "github", "incident:expired", "expired", false, false, now - retention - 1)
  state.acknowledge(101, "github", "incident:boundary", "boundary", false, false, now - retention)
  state.acknowledge(-202, "github", "incident:removed-chat", "chat", true, false, now)
  state.acknowledge(101, "openai", "incident:removed-provider", "provider", true, false, now)

  state.prune([101], ["github"], now)
  expect(state.get(101, "github", "incident:active")?.active).toBe(1)
  expect(state.get(101, "github", "incident:boundary")?.active).toBe(0)
  expect(state.get(101, "github", "incident:expired")).toBeUndefined()
  expect(state.active("openai")).toEqual([])
  expect(state.get(-202, "github", "incident:removed-chat")).toBeUndefined()
  state.prune([], [], now)
  expect(f.store.db.prepare("SELECT * FROM status_deliveries").all()).toEqual([])
})

it("preserves acknowledgements and unrelated administration data across AdminStore reopen", () => {
  const f = fixture()
  const state = new StatusDeliveryState(f.store.db)
  f.store.applied(1, true)
  f.store.observe(-202, "group", "Status destination")
  state.acknowledge(-202, "openai", "summary", "durable-fingerprint", true, false, now)
  const snapshot = f.store.snapshot()

  const restored = f.reopen()
  expect(restored.get(-202, "openai", "summary")).toEqual({
    chatId: -202,
    provider: "openai",
    eventId: "summary",
    fingerprint: "durable-fingerprint",
    active: 1,
    maintenance: 0,
  })
  expect(f.store.snapshot()).toEqual(snapshot)
  expect(f.store.listChats(0)).toContainEqual({
    id: -202,
    type: "group",
    name: "Status destination",
  })
})
