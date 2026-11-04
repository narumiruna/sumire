import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ServiceStatusDiagnostic } from "@narumitw/sumire-contracts"
import { afterEach, expect, it } from "vitest"
import { AdminStore } from "../src/admin/store.js"
import { type PendingStatusNotification, StatusDeliveryState } from "../src/service-status/state.js"

const cleanup: Array<() => void> = []
const now = Date.parse("2030-01-31T12:00:00Z")
const retention = 30 * 24 * 3600_000
const maxEventBytes = 256 * 1024

type Input = Omit<PendingStatusNotification, "version">

function input(overrides: Partial<Input> = {}): Input {
  const eventId = overrides.eventId ?? "incident:first"
  return {
    chatId: 101,
    provider: "github",
    eventId,
    fingerprint: "first-fingerprint",
    event: {
      id: eventId,
      kind: "incident",
      active: true,
      maintenance: false,
      name: "API incident",
      status: "investigating",
      impact: "major",
      url: "https://www.githubstatus.com/incidents/first",
      body: "Synthetic upstream body",
      components: [{ id: "api", name: "API", status: "partial_outage" }],
    },
    change: "new",
    dueAt: now + 60_000,
    firstSeenAt: now,
    changes: 1,
    ruleFingerprint: "github-rule",
    initial: true,
    ...overrides,
  }
}

function sizedInput(bytes: number, overrides: Partial<Input> = {}): Input {
  const row = input(overrides)
  row.event = { ...row.event, body: "" }
  const overhead = Buffer.byteLength(JSON.stringify(row.event))
  row.event.body = "x".repeat(bytes - overhead)
  expect(Buffer.byteLength(JSON.stringify(row.event))).toBe(bytes)
  return row
}

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sumire-status-queue-"))
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
    state: new StatusDeliveryState(store.db),
    reopen() {
      store.close()
      store = new AdminStore(file, 42)
      return new StatusDeliveryState(store.db)
    },
  }
}

function queued(state: StatusDeliveryState, row = input()): PendingStatusNotification {
  expect(state.admit(row)).toBe(true)
  const stored = state.pendingGet(row.chatId, row.provider, row.eventId)
  if (!stored) throw new Error("Expected an admitted queue row")
  return stored
}

afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})

it("persists prepared queue content and versions without scheduling, filtering, or acknowledging", () => {
  const f = fixture()
  const original = queued(f.state, input({ dueAt: now - 1, initial: false }))
  expect(original).toEqual({ ...input({ dueAt: now - 1, initial: false }), version: 1 })
  const resolved = input({
    ...original,
    fingerprint: "recovered-fingerprint",
    event: { ...original.event, active: false, status: "resolved", impact: "none" },
    change: "resolved",
    dueAt: now + 120_000,
    changes: 2,
    initial: true,
  })
  const replacement = queued(f.state, resolved)
  expect(replacement.version).toBeGreaterThan(original.version)
  expect(f.state.pending()).toEqual([replacement])
  expect(f.state.get(101, "github", original.eventId)).toBeUndefined()
  const restored = f.reopen()
  expect(restored.pendingGet(101, "github", original.eventId)).toEqual(replacement)
  expect(restored.nextDue()).toBe(resolved.dueAt)
  const updated = queued(restored, { ...resolved, changes: 3 })
  expect(updated.version).toBeGreaterThan(replacement.version)
})

it("bounds each chat at 100 rows and leaves failed new admissions and replacements unchanged", () => {
  const { state } = fixture()
  for (let index = 0; index < 100; index++) queued(state, input({ eventId: `incident:${index}` }))
  const before = state.pending()
  expect(state.admit(input({ eventId: "incident:overflow" }))).toBe(false)
  expect(state.pending()).toEqual(before)
  const original = state.pendingGet(101, "github", "incident:0")
  expect(original).toBeDefined()
  expect(
    state.admit(sizedInput(maxEventBytes + 1, { eventId: "incident:0", fingerprint: "rejected" })),
  ).toBe(false)
  expect(state.pendingGet(101, "github", "incident:0")).toEqual(original)
  const replaced = queued(state, input({ eventId: "incident:0", fingerprint: "replacement" }))
  expect(replaced.version).toBe((original?.version ?? 0) + 100)
  expect(state.pending()).toHaveLength(100)
  queued(state, input({ chatId: -202, eventId: "incident:overflow" }))
  expect(state.pending()).toHaveLength(101)
})

it("bounds the entire queue at 10,000 rows while permitting replacement at capacity", () => {
  const f = fixture()
  // One outer transaction keeps the synthetic capacity fixture fast and exercises savepoints.
  f.store.db.exec("BEGIN")
  try {
    for (let chatId = 1; chatId <= 100; chatId++) {
      for (let index = 0; index < 100; index++) {
        if (!f.state.admit(input({ chatId, eventId: `incident:${index}` })))
          throw new Error("Unexpected admission failure before capacity")
      }
    }
    f.store.db.exec("COMMIT")
  } catch (error) {
    f.store.db.exec("ROLLBACK")
    throw error
  }
  expect(f.state.pending()).toHaveLength(10_000)
  const original = f.state.pendingGet(1, "github", "incident:0")
  expect(f.state.admit(input({ chatId: 101 }))).toBe(false)
  expect(f.state.pending(101)).toEqual([])
  expect(f.state.pendingGet(1, "github", "incident:0")).toEqual(original)
  const replaced = queued(f.state, input({ chatId: 1, eventId: "incident:0", changes: 2 }))
  expect(replaced.version).toBe(10_001)
  expect(f.state.pending()).toHaveLength(10_000)
}, 30_000)

it("accounts for serialized UTF-8 bytes and replacement bytes at the 16 MiB total bound", () => {
  const { state } = fixture()
  for (let index = 0; index < 64; index++)
    queued(state, sizedInput(maxEventBytes, { eventId: `incident:${index}` }))
  const full = state.pendingGet(101, "github", "incident:0")
  expect(state.admit(input({ eventId: "incident:overflow" }))).toBe(false)
  const sameSize = queued(state, sizedInput(maxEventBytes, { eventId: "incident:0", changes: 2 }))
  expect(sameSize.version).toBeGreaterThan(full?.version ?? 0)
  const small = queued(state, sizedInput(1024, { eventId: "incident:0" }))
  const added = queued(state, sizedInput(maxEventBytes - 1024, { eventId: "incident:overflow" }))
  expect(
    state.admit(sizedInput(maxEventBytes - 1023, { eventId: "incident:overflow", changes: 3 })),
  ).toBe(false)
  expect(state.pendingGet(101, "github", "incident:0")).toEqual(small)
  expect(state.pendingGet(101, "github", "incident:overflow")).toEqual(added)
  state.clearPending(101, "github", "incident:1")
  queued(state, sizedInput(maxEventBytes, { eventId: "incident:overflow", changes: 4 }))
  const unicode = input({ eventId: "incident:unicode" })
  unicode.event.body = "界".repeat(100_000)
  expect(unicode.event.body.length).toBeLessThan(maxEventBytes)
  expect(state.admit(unicode)).toBe(false)
  expect(state.pendingGet(101, "github", "incident:unicode")).toBeUndefined()
})

it("rolls back the version and row if an admission write fails", () => {
  const f = fixture()
  const row = queued(f.state)
  f.store.db.exec(`
    CREATE TRIGGER reject_status_admission BEFORE UPDATE ON status_pending
    BEGIN SELECT RAISE(ABORT,'synthetic admission failure'); END;
  `)
  expect(() => f.state.admit(input({ fingerprint: "rejected" }))).toThrow(
    "synthetic admission failure",
  )
  expect(f.state.pending()).toEqual([row])
  f.store.db.exec("DROP TRIGGER reject_status_admission")
  expect(queued(f.state, input({ changes: 2 })).version).toBe(row.version + 1)
})

it("acknowledges the sent version and metadata without deleting a later admitted update", () => {
  const { state } = fixture()
  const sent = queued(state)
  const updated = queued(
    state,
    input({
      fingerprint: "latest-fingerprint",
      event: { ...sent.event, impact: "critical", components: [] },
      changes: 2,
      initial: false,
    }),
  )
  expect(state.complete(sent, now)).toBe(true)
  expect(state.pending()).toEqual([updated])
  expect(state.get(101, "github", sent.eventId)).toEqual({
    chatId: sent.chatId,
    provider: sent.provider,
    eventId: sent.eventId,
    fingerprint: sent.fingerprint,
    active: 1,
    maintenance: 0,
    components: sent.event.components,
    impact: sent.event.impact,
  })
  expect(state.complete(updated, now + 1)).toBe(true)
  expect(state.pending()).toEqual([])
  expect(state.get(101, "github", sent.eventId)).toMatchObject({
    fingerprint: "latest-fingerprint",
    components: [],
    impact: "critical",
  })
  expect(state.complete(sent, now + 2)).toBe(false)
  expect(state.get(101, "github", sent.eventId)?.fingerprint).toBe("latest-fingerprint")
  expect(state.results({ offset: 0, limit: 100 }, now, null).items).toEqual([])
})

it("commits acknowledgement and matching-version removal in one transaction", () => {
  const f = fixture()
  const row = queued(f.state)
  f.store.db.exec(`
    CREATE TRIGGER reject_status_completion BEFORE DELETE ON status_pending
    BEGIN SELECT RAISE(ABORT,'synthetic completion failure'); END;
  `)
  expect(() => f.state.complete(row, now)).toThrow("synthetic completion failure")
  expect(f.state.get(row.chatId, row.provider, row.eventId)).toBeUndefined()
  expect(f.state.pending()).toEqual([row])
  f.store.db.exec("DROP TRIGGER reject_status_completion")
  expect(f.state.complete({ ...row, version: row.version + 1 }, now)).toBe(false)
  expect(f.state.pending()).toEqual([row])
  expect(f.state.complete(row, now)).toBe(true)
  expect(f.state.pending()).toEqual([])
  const restored = f.reopen()
  expect(restored.get(row.chatId, row.provider, row.eventId)?.fingerprint).toBe(row.fingerprint)
  expect(restored.pending()).toEqual([])
})

it("does not reuse a version after removal and re-admission", () => {
  const { state } = fixture()
  const old = queued(state)
  state.clearPending(old.chatId, old.provider, old.eventId)
  expect(state.complete(old, now)).toBe(false)
  expect(state.get(old.chatId, old.provider, old.eventId)).toBeUndefined()
  const current = queued(state, input({ fingerprint: "new-admission" }))
  expect(current.version).toBeGreaterThan(old.version)
  expect(state.complete(old, now)).toBe(true)
  expect(state.pending()).toEqual([current])
})

it("orders due work deterministically and clears only the selected chat, provider, and event", () => {
  const { state } = fixture()
  expect(state.nextDue()).toBeUndefined()
  const rows = [
    queued(state, input({ chatId: 101, provider: "openai", dueAt: now })),
    queued(state, input({ chatId: -202, eventId: "incident:b", dueAt: now })),
    queued(state, input({ chatId: -202, eventId: "incident:a", dueAt: now })),
    queued(state, input({ chatId: 101, eventId: "incident:future", dueAt: now + 1 })),
    queued(state, input({ chatId: 101, dueAt: now - 1 })),
  ]
  expect(state.nextDue()).toBe(now - 1)
  expect(state.due(now)).toEqual([rows[4], rows[2], rows[1], rows[0]])
  expect(state.due(now, 2)).toEqual([rows[4], rows[2]])
  expect(state.due(now, 0)).toEqual([])
  expect(state.pending(undefined, "openai")).toEqual([rows[0]])
  state.clearPending(-202, "github", "incident:a")
  expect(state.pending(-202)).toEqual([rows[1]])
  state.clearPending(101, "github")
  expect(state.pending(101)).toEqual([rows[0]])
  state.clearPending(-202)
  expect(state.pending()).toEqual([rows[0]])
  state.clearPending(101, undefined, "incident:first")
  expect(state.nextDue()).toBeUndefined()
  expect(state.due(now + 1)).toEqual([])
})

it("forgets only the selected obsolete checkpoint and pending row without changing delivery results", () => {
  const { state } = fixture()
  const obsolete = queued(state, input({ eventId: "summary:old-scope" }))
  const retained = [
    queued(state, input({ eventId: "summary:new-scope" })),
    queued(state, input({ chatId: -202, eventId: obsolete.eventId })),
    queued(state, input({ provider: "openai", eventId: obsolete.eventId })),
  ]
  for (const row of [obsolete, ...retained]) {
    state.acknowledge(row.chatId, row.provider, row.eventId, row.fingerprint, true, false, now)
    state.recordDelivery(row.chatId, row.provider, true, now)
  }
  state.forget(obsolete.chatId, obsolete.provider, obsolete.eventId)
  expect(state.pendingGet(obsolete.chatId, obsolete.provider, obsolete.eventId)).toBeUndefined()
  expect(state.get(obsolete.chatId, obsolete.provider, obsolete.eventId)).toBeUndefined()
  for (const row of retained) {
    expect(state.pendingGet(row.chatId, row.provider, row.eventId)).toEqual(row)
    expect(state.get(row.chatId, row.provider, row.eventId)?.active).toBe(1)
  }
  expect(state.results({ offset: 0, limit: 100 }, now, null).total).toBe(3)
})

it("persists an attempt-only test cooldown without reporting a failure or changing prior outcomes", () => {
  const f = fixture()
  const pending = queued(f.state)
  f.state.recordAttempt(101, "test", now)
  expect(f.state.lastTestAttempt(101)).toBe(now)
  expect(f.state.results({ offset: 0, limit: 100, provider: "test" }, now, null).items).toEqual([
    {
      chatId: 101,
      provider: "test",
      lastAttemptAt: now,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      pendingCount: 0,
      nextDueAt: null,
    },
  ])
  f.state.recordDelivery(101, "test", true, now + 1)
  f.state.recordDelivery(101, "test", false, now + 2, "forbidden")
  f.state.recordAttempt(101, "test", now + 3)
  expect(f.state.pending()).toEqual([pending])
  expect(f.state.get(101, "github", pending.eventId)).toBeUndefined()
  const restored = f.reopen()
  expect(restored.lastTestAttempt(101)).toBe(now + 3)
  expect(restored.results({ offset: 0, limit: 100, provider: "test" }, now, null).items).toEqual([
    {
      chatId: 101,
      provider: "test",
      lastAttemptAt: now + 3,
      lastSuccessAt: now + 1,
      lastFailureAt: now + 2,
      lastError: "forbidden",
      pendingCount: 0,
      nextDueAt: null,
    },
  ])
})

it("limits a default due page to 100 rows", () => {
  const { state } = fixture()
  for (let index = 0; index < 100; index++)
    queued(state, input({ eventId: `incident:${index}`, dueAt: now }))
  queued(state, input({ chatId: -202, dueAt: now }))
  expect(state.due(now)).toHaveLength(100)
  expect(state.due(now, 101)).toHaveLength(101)
})

it("prunes each chat's effective providers, not the global union, and preserves selected test results", () => {
  const { state } = fixture()
  const metadata = { components: input().event.components, impact: "major" as const }
  for (const chatId of [101, -202, 303, 404]) {
    for (const provider of ["github", "openai"] as const) {
      state.acknowledge(
        chatId,
        provider,
        "active",
        "active",
        true,
        false,
        now - retention - 1,
        metadata,
      )
      queued(state, input({ chatId, provider, ruleFingerprint: `${provider}-rule` }))
      state.recordDelivery(chatId, provider, true, now)
    }
    state.recordDelivery(chatId, "test", true, now)
  }
  for (const provider of ["github", "openai", "claude", "cloudflare"] as const)
    state.recordSource(provider, true, now)
  state.acknowledge(101, "github", "expired", "expired", false, false, now - retention - 1)
  state.acknowledge(101, "github", "boundary", "boundary", false, false, now - retention)
  const subscriptions = [
    { chatId: 101, providers: ["github"] as const, ruleFingerprint: "github-rule" },
    { chatId: -202, providers: ["openai"] as const, ruleFingerprint: "openai-rule" },
    { chatId: 303, providers: [], ruleFingerprint: "empty-rule" },
  ]
  state.pruneSubscriptions(subscriptions, true, now)
  expect(state.pending().map((row) => [row.chatId, row.provider])).toEqual([
    [-202, "openai"],
    [101, "github"],
  ])
  expect(state.active("github")).toEqual([
    {
      chatId: 101,
      provider: "github",
      eventId: "active",
      fingerprint: "active",
      active: 1,
      maintenance: 0,
      ...metadata,
    },
  ])
  expect(state.active("openai").map((row) => row.chatId)).toEqual([-202])
  expect(state.get(101, "github", "expired")).toBeUndefined()
  expect(state.get(101, "github", "boundary")?.active).toBe(0)
  const results = state.results({ offset: 0, limit: 100 }, now, null)
  expect(results.items.map((row) => [row.chatId, row.provider])).toEqual([
    [-202, "openai"],
    [-202, "test"],
    [101, "github"],
    [101, "test"],
    [303, "test"],
  ])
  const pending = state.pending()
  state.pruneSubscriptions(subscriptions, true, now)
  expect(state.pending()).toEqual(pending)
  state.pruneSubscriptions(
    subscriptions.map((subscription) =>
      subscription.chatId === 101
        ? { ...subscription, ruleFingerprint: "changed-rule" }
        : subscription,
    ),
    true,
    now,
  )
  expect(state.pending().map((row) => row.chatId)).toEqual([-202])
  expect(state.get(101, "github", "active")).toMatchObject(metadata)
  state.pruneSubscriptions(subscriptions, false, now)
  expect(state.pending()).toEqual([])
  expect(state.active("github")).toHaveLength(1)
  expect(state.results({ offset: 0, limit: 100 }, now, null).total).toBe(5)
  state.pruneSubscriptions([], false, now)
  expect(state.active("github")).toEqual([])
  expect(state.active("openai")).toEqual([])
  const removed = state.results({ offset: 0, limit: 100 }, now, null)
  expect(removed.items).toEqual([])
  expect(removed.sources).toHaveLength(4)
})

it("separates source, automatic, and test health and retains independent success and failure times after restart", () => {
  const f = fixture()
  const row = queued(f.state)
  expect(f.state.lastTestAttempt(101)).toBeUndefined()
  f.state.recordSource("github", true, now)
  f.state.recordSource("github", false, now + 1, "source_unavailable")
  f.state.recordDelivery(101, "github", true, now + 2)
  f.state.recordDelivery(101, "github", false, now + 3, "forbidden")
  expect(f.state.lastTestAttempt(101)).toBeUndefined()
  f.state.recordDelivery(101, "test", false, now + 4, "chat_unavailable")
  f.state.recordDelivery(101, "test", true, now + 5)
  expect(f.state.lastTestAttempt(101)).toBe(now + 5)
  expect(f.state.pending()).toEqual([row])
  expect(f.state.get(101, "github", row.eventId)).toBeUndefined()
  const results = f.state.results({ offset: 0, limit: 100 }, now + 10, now + 60_000)
  expect(results).toEqual({
    items: [
      {
        chatId: 101,
        provider: "github",
        lastAttemptAt: now + 3,
        lastSuccessAt: now + 2,
        lastFailureAt: now + 3,
        lastError: "forbidden",
        pendingCount: 1,
        nextDueAt: row.dueAt,
      },
      {
        chatId: 101,
        provider: "test",
        lastAttemptAt: now + 5,
        lastSuccessAt: now + 5,
        lastFailureAt: now + 4,
        lastError: "chat_unavailable",
        pendingCount: 0,
        nextDueAt: null,
      },
    ],
    sources: [
      {
        provider: "github",
        lastAttemptAt: now + 1,
        lastSuccessAt: now,
        lastFailureAt: now + 1,
        lastError: "source_unavailable",
      },
    ],
    offset: 0,
    limit: 100,
    total: 2,
    serverTime: now + 10,
    nextPollAt: now + 60_000,
  })
  const restored = f.reopen()
  expect(restored.results({ offset: 0, limit: 100 }, now + 10, now + 60_000)).toEqual(results)
  expect(restored.lastTestAttempt(101)).toBe(now + 5)
  restored.recordSource("github", true, now + 11)
  restored.recordDelivery(101, "github", true, now + 12)
  expect(restored.results({ offset: 0, limit: 100 }, now, null)).toMatchObject({
    items: [{ lastSuccessAt: now + 12, lastFailureAt: now + 3, lastError: "forbidden" }, {}],
    sources: [{ lastSuccessAt: now + 11, lastFailureAt: now + 1, lastError: "source_unavailable" }],
    nextPollAt: null,
  })
})

it("paginates the union of pending and health keys with matching totals and null missing fields", () => {
  const { state } = fixture()
  queued(state, input({ chatId: -202, provider: "openai" }))
  queued(state, input({ chatId: -202, provider: "openai", eventId: "incident:second", dueAt: now }))
  queued(state, input({ chatId: 101, provider: "github" }))
  state.recordDelivery(101, "github", true, now)
  state.recordDelivery(-202, "github", false, now)
  state.recordDelivery(101, "test", true, now)
  state.recordSource("github", true, now)
  state.recordSource("openai", false, now, "timeout")
  const page = state.results({ offset: 1, limit: 2 }, now, null)
  expect(page.total).toBe(4)
  expect(page.offset).toBe(1)
  expect(page.limit).toBe(2)
  expect(page.items).toEqual([
    {
      chatId: -202,
      provider: "openai",
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      pendingCount: 2,
      nextDueAt: now,
    },
    {
      chatId: 101,
      provider: "github",
      lastAttemptAt: now,
      lastSuccessAt: now,
      lastFailureAt: null,
      lastError: null,
      pendingCount: 1,
      nextDueAt: now + 60_000,
    },
  ])
  const chat = state.results({ offset: 0, limit: 100, chatId: -202 }, now, null)
  expect(chat.total).toBe(2)
  expect(chat.items.map((row) => row.provider)).toEqual(["github", "openai"])
  const provider = state.results({ offset: 1, limit: 1, provider: "github" }, now, null)
  expect(provider.total).toBe(2)
  expect(provider.items.map((row) => row.chatId)).toEqual([101])
  expect(provider.sources.map((row) => row.provider)).toEqual(["github"])
  const test = state.results({ offset: 0, limit: 100, provider: "test" }, now, null)
  expect(test.total).toBe(1)
  expect(test.sources).toEqual([])
  const empty = state.results({ offset: 0, limit: 100, chatId: -202, provider: "test" }, now, null)
  expect(empty.total).toBe(0)
  expect(empty.items).toEqual([])
  expect(state.results({ offset: 10_000, limit: 100 }, now, null).items).toEqual([])
})

it("bounds result pages and keeps only the latest health state without returning raw event or error bodies", () => {
  const f = fixture()
  const rawBody = "Synthetic untrusted provider body that must not appear in results"
  const row = input()
  row.event.body = rawBody
  queued(f.state, row)
  for (let chatId = 1; chatId <= 105; chatId++) f.state.recordDelivery(chatId, "test", true, now)
  for (let index = 0; index < 100; index++) {
    f.state.recordDelivery(101, "github", false, now + index, "delivery_failed")
    f.state.recordSource("github", false, now + index, "source_unavailable")
  }
  f.state.recordSource("openai", false, now, rawBody as ServiceStatusDiagnostic)
  const results = f.state.results({ offset: 0, limit: 1000 }, now, null)
  expect(results.limit).toBe(100)
  expect(results.items).toHaveLength(100)
  expect(results.total).toBe(106)
  expect(JSON.stringify(results)).not.toContain(rawBody)
  expect(results.sources.find((source) => source.provider === "openai")?.lastError).toBeNull()
  expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM status_delivery_health").get()).toEqual({
    count: 106,
  })
  expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM status_source_health").get()).toEqual({
    count: 2,
  })
})
