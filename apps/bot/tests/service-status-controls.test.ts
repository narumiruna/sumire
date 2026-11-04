import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  initialStatusNotifications,
  type Policy,
  type StatusNotifications,
} from "@narumitw/sumire-policy"
import type {
  readStatusIncident,
  readStatusSummary,
  StatusComponent,
  StatusIncident,
  StatusProviderId,
  StatusSummary,
} from "@narumitw/sumire-status-page"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AdminStore } from "../src/admin/store.js"
import {
  eventFingerprint,
  formatStatusNotification,
  incidentEvent,
} from "../src/service-status/events.js"
import {
  StatusNotificationWorker,
  type StatusWorkerClock,
  type StatusWorkerOptions,
} from "../src/service-status/runtime.js"
import { StatusDeliveryState } from "../src/service-status/state.js"

const base = Date.parse("2030-01-01T12:00:00Z")
const cleanup: Array<() => Promise<void>> = []

class ControlledClock implements StatusWorkerClock {
  #now: number
  #monotonic = 0
  readonly #sleepers = new Set<{ dueAt: number; release(): void }>()

  constructor(now = base) {
    this.#now = now
  }

  now() {
    return this.#now
  }

  monotonic() {
    return this.#monotonic
  }

  get nextWaitAt() {
    return Math.min(...[...this.#sleepers].map((sleeper) => sleeper.dueAt))
  }

  advanceTo(now: number) {
    if (now < this.#now) throw new Error("The test clock cannot move backwards")
    this.#monotonic += now - this.#now
    this.#now = now
    for (const sleeper of [...this.#sleepers]) {
      if (sleeper.dueAt <= now) sleeper.release()
    }
  }

  async wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    // Transport spacing advances immediately; worker sleeps need an explicit clock advance.
    if (milliseconds <= 100) {
      this.advanceTo(this.#now + milliseconds)
      return
    }
    await new Promise<void>((resolve, reject) => {
      const release = () => {
        this.#sleepers.delete(sleeper)
        signal.removeEventListener("abort", abort)
        resolve()
      }
      const abort = () => {
        this.#sleepers.delete(sleeper)
        signal.removeEventListener("abort", abort)
        reject(signal.reason)
      }
      const sleeper = { dueAt: this.#now + milliseconds, release }
      this.#sleepers.add(sleeper)
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
    })
  }
}

function incident(overrides: Partial<StatusIncident> = {}): StatusIncident {
  return {
    id: "api-errors",
    name: "API errors",
    status: "investigating",
    impact: "major",
    url: "https://www.githubstatus.com/incidents/api-errors",
    updatedAt: "2030-01-01T12:00:00Z",
    body: "Initial API incident.",
    components: [{ id: "api", name: "API", status: "partial_outage" }],
    ...overrides,
  }
}

function summary(
  provider: StatusProviderId,
  overrides: Partial<StatusSummary> = {},
): StatusSummary {
  return {
    provider,
    indicator: "none",
    description: "All systems operational",
    components: [],
    incidents: [],
    maintenances: [],
    ...overrides,
  }
}

function deferred<T>() {
  let resolve = (_value: T) => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function settleUntil(condition: () => boolean) {
  for (let turn = 0; turn < 200; turn++) {
    if (condition()) return
    await Promise.resolve()
  }
  expect(condition(), "The worker did not reach the expected clock wait").toBe(true)
}

function fixture(overrides: Partial<StatusNotifications> = {}, now = base) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sumire-status-controls-"))
  const file = path.join(directory, "admin.sqlite")
  let store = new AdminStore(file, 42)
  const workers: StatusNotificationWorker[] = []
  const clock = new ControlledClock(now)
  const summaries = new Map<StatusProviderId, StatusSummary>([
    ["github", summary("github", { incidents: [incident()] })],
  ])
  const readSummary = vi.fn<typeof readStatusSummary>(async (provider) =>
    structuredClone(summaries.get(provider) ?? summary(provider)),
  )
  const readIncident = vi
    .fn<typeof readStatusIncident>()
    .mockRejectedValue(new Error("Synthetic incident detail unavailable"))
  const send = vi.fn<StatusWorkerOptions["send"]>().mockResolvedValue(undefined)
  const logger = { warn: vi.fn() }
  const apply = (change: (policy: Policy) => void) => {
    const before = store.snapshot()
    change(before.policy)
    const saved = store.save(before.policy, before.revision, "42")
    store.applied(saved.revision, true)
  }
  const configure = (settings: Partial<StatusNotifications>) => {
    apply((policy) => {
      policy.statusNotifications = { ...policy.statusNotifications, ...settings }
    })
  }
  const create = () => {
    const worker = new StatusNotificationWorker({
      store,
      readSummary,
      readIncident,
      send,
      logger,
      clock,
    })
    workers.push(worker)
    return worker
  }
  cleanup.push(async () => {
    await Promise.all(workers.map((worker) => worker.close()))
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  configure({
    ...initialStatusNotifications(),
    enabled: true,
    providers: ["github"],
    chatIds: [101],
    pollIntervalSeconds: 3600,
    ...overrides,
  })
  const worker = create()
  return {
    worker,
    clock,
    summaries,
    readSummary,
    readIncident,
    send,
    logger,
    apply,
    configure,
    get store() {
      return store
    },
    state: () => new StatusDeliveryState(store.db),
    async reopen() {
      await Promise.all(workers.map((item) => item.close()))
      store.close()
      store = new AdminStore(file, 42)
      return create()
    },
  }
}

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

describe("service status subscription controls", () => {
  it("polls the effective provider union once even when shared sources are empty", async () => {
    const f = fixture({
      providers: [],
      chatIds: [101, -202, -303, 404, 505],
      chatOverrides: {
        "101": { providers: ["github"] },
        "-202": { providers: ["openai"] },
        "-303": { providers: ["github", "openai"] },
        "404": { providers: [] },
      },
    })
    f.summaries.set(
      "openai",
      summary("openai", {
        incidents: [
          incident({
            id: "model-errors",
            name: "Model errors",
            url: "https://status.openai.com/incidents/model-errors",
          }),
        ],
      }),
    )

    await f.worker.poll()

    expect(f.readSummary.mock.calls.map(([provider]) => provider).sort()).toEqual([
      "github",
      "openai",
    ])
    expect(f.send.mock.calls.map(([chatId]) => chatId).sort((a, b) => a - b)).toEqual([
      -303, -303, -202, 101,
    ])
    const github = f.send.mock.calls.find(([chatId]) => chatId === 101)?.[1]
    const openai = f.send.mock.calls.find(([chatId]) => chatId === -202)?.[1]
    const both = f.send.mock.calls
      .filter(([chatId]) => chatId === -303)
      .map(([, text]) => text)
      .join("\n")
    expect(github).toContain("[GitHub]")
    expect(github).not.toContain("[OpenAI]")
    expect(openai).toContain("[OpenAI]")
    expect(openai).not.toContain("[GitHub]")
    expect(both).toContain("[GitHub]")
    expect(both).toContain("[OpenAI]")
    expect(f.store.allows(101)).toBe(false)
    expect(f.state().get(101, "openai", "incident:model-errors")).toBeUndefined()
    expect(f.state().get(-202, "github", "incident:api-errors")).toBeUndefined()

    await f.worker.poll()
    expect(f.readSummary).toHaveBeenCalledTimes(4)
    expect(f.send).toHaveBeenCalledTimes(4)
    expect(f.state().get(-303, "github", "incident:api-errors")?.active).toBe(1)
    expect(f.state().get(-303, "openai", "incident:model-errors")?.active).toBe(1)
  })

  it("inherits shared severity but applies a selective chat threshold and an explicit empty source list", async () => {
    const f = fixture({
      minimumImpact: "minor",
      chatIds: [101, -202, 303],
      chatOverrides: {
        "-202": { minimumImpact: "critical" },
        "303": { providers: [] },
      },
    })
    f.summaries.set("github", summary("github", { incidents: [incident({ impact: "minor" })] }))
    await f.worker.poll()
    expect(f.send.mock.calls.map(([chatId]) => chatId)).toEqual([101])
    expect(f.state().get(-202, "github", "incident:api-errors")).toBeUndefined()

    f.summaries.set("github", summary("github", { incidents: [incident({ impact: "critical" })] }))
    await f.worker.poll()
    expect(
      f.send.mock.calls
        .slice(1)
        .map(([chatId]) => chatId)
        .sort((a, b) => a - b),
    ).toEqual([-202, 101])
    expect(f.send.mock.calls.some(([chatId]) => chatId === 303)).toBe(false)
    expect(f.readSummary).toHaveBeenCalledTimes(2)
  })

  it("scopes group aggregates per chat without unrelated incident suppression or incomplete-catalog recovery", async () => {
    const f = fixture({
      chatIds: [101, -202, 303, 404],
      componentSelections: { github: ["storage"] },
      chatOverrides: {
        "101": { componentSelections: { github: ["region"] } },
        "303": { componentSelections: { github: ["unavailable"] } },
        "404": { componentSelections: { github: [] } },
      },
    })
    const region: StatusComponent = {
      id: "region",
      name: "Provider region",
      status: "operational",
      isGroup: true,
    }
    const api: StatusComponent = {
      id: "api",
      name: "Regional API",
      status: "partial_outage",
      groupId: "region",
    }
    const storage: StatusComponent = { id: "storage", name: "Storage", status: "partial_outage" }
    const unrelated = incident({
      id: "storage-errors",
      name: "Storage incident",
      components: [storage],
    })
    const unknown = incident({ id: "unknown", name: "No component association", components: [] })
    const setCatalog = (components: StatusComponent[]) => {
      f.summaries.set(
        "github",
        summary("github", {
          indicator: "critical",
          components,
          incidents: [unrelated, unknown],
        }),
      )
    }
    setCatalog([region, api, storage])
    await f.worker.poll()

    expect(f.send).toHaveBeenCalledTimes(2)
    const aggregate = f
      .state()
      .active("github")
      .find((row) => row.chatId === 101)
    expect(aggregate?.eventId).toMatch(/^summary:/)
    expect(aggregate?.components?.map(({ id }) => id).sort()).toEqual(["api", "region"])
    const regionalMessage = f.send.mock.calls.find(([chatId]) => chatId === 101)?.[1]
    expect(regionalMessage).toContain("Regional API")
    expect(regionalMessage).not.toContain("Storage incident")
    expect(regionalMessage).not.toContain("No component association")
    expect(
      f
        .state()
        .active("github")
        .filter((row) => row.chatId === -202),
    ).toEqual([expect.objectContaining({ eventId: "incident:storage-errors" })])
    expect(f.send.mock.calls.some(([chatId]) => chatId === 303 || chatId === 404)).toBe(false)

    setCatalog([region, storage])
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.state().get(101, "github", aggregate?.eventId ?? "missing")?.active).toBe(1)

    const newChild: StatusComponent = {
      id: "new-api",
      name: "New regional API",
      status: "partial_outage",
      groupId: "region",
    }
    setCatalog([region, { ...api, status: "operational" }, newChild, storage])
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledTimes(3)
    expect(f.send.mock.calls[2]?.[0]).toBe(101)
    expect(f.send.mock.calls[2]?.[1]).toContain("New regional API")

    setCatalog([
      region,
      { ...api, status: "operational" },
      { ...newChild, status: "operational" },
      storage,
    ])
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledTimes(4)
    expect(f.send.mock.calls[3]?.[0]).toBe(101)
    expect(f.send.mock.calls[3]?.[1]).toContain("[GitHub] 已恢復")
    expect(f.state().get(101, "github", aggregate?.eventId ?? "missing")?.active).toBe(0)
    expect(f.state().get(-202, "github", "incident:storage-errors")?.active).toBe(1)
    expect(f.readSummary).toHaveBeenCalledTimes(4)
  })

  it("confirms a filtered incident recovery from terminal details without component associations", async () => {
    const f = fixture({
      chatIds: [101, -202],
      componentSelections: { github: ["storage"] },
      chatOverrides: { "101": { componentSelections: { github: ["region"] } } },
    })
    const region: StatusComponent = {
      id: "region",
      name: "Region",
      status: "operational",
      isGroup: true,
    }
    const api: StatusComponent = {
      id: "api",
      name: "API",
      status: "partial_outage",
      groupId: "region",
    }
    const storage: StatusComponent = { id: "storage", name: "Storage", status: "operational" }
    f.summaries.set(
      "github",
      summary("github", {
        components: [region, api, storage],
        incidents: [incident({ components: [api] })],
      }),
    )
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledOnce()
    expect(
      f
        .state()
        .active("github")
        .map(({ eventId }) => eventId),
    ).toEqual(["incident:api-errors"])

    f.readIncident.mockResolvedValue(
      incident({ status: "resolved", impact: "none", components: [], body: "API restored." }),
    )
    f.summaries.set(
      "github",
      summary("github", { components: [region, { ...api, status: "operational" }, storage] }),
    )
    await f.worker.poll()
    expect(f.readIncident).toHaveBeenCalledExactlyOnceWith(
      "github",
      "api-errors",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
    expect(f.send.mock.calls.map(([chatId]) => chatId)).toEqual([101, 101])
    expect(f.send.mock.calls[1]?.[1]).toContain("[GitHub] 已恢復")
    expect(f.state().get(101, "github", "incident:api-errors")).toMatchObject({
      active: 0,
      components: [api],
    })
    expect(f.state().get(-202, "github", "incident:api-errors")).toBeUndefined()
  })
})

describe("service status durable scheduling", () => {
  it.each([60, 300, 900] as const)(
    "keeps a fixed %s-second update window and flushes only the latest content without polling",
    async (batchWindowSeconds) => {
      const f = fixture({ batchWindowSeconds })
      await f.worker.poll()
      expect(f.send).toHaveBeenCalledOnce()
      expect(f.state().pending()).toEqual([])

      f.clock.advanceTo(base + 1000)
      f.summaries.set(
        "github",
        summary("github", { incidents: [incident({ body: "First update." })] }),
      )
      await f.worker.poll()
      const first = f.state().pendingGet(101, "github", "incident:api-errors")
      expect(first).toMatchObject({
        dueAt: base + 1000 + batchWindowSeconds * 1000,
        firstSeenAt: base + 1000,
        changes: 1,
        initial: false,
        change: "update",
      })

      f.clock.advanceTo(base + 31_000)
      const latest = incident({ body: "Latest fixed-window update.", status: "monitoring" })
      f.summaries.set("github", summary("github", { incidents: [latest] }))
      await f.worker.poll()
      await f.worker.poll()
      const queued = f.state().pendingGet(101, "github", "incident:api-errors")
      expect(queued).toMatchObject({
        dueAt: first?.dueAt,
        firstSeenAt: first?.firstSeenAt,
        changes: 2,
        fingerprint: eventFingerprint(incidentEvent(latest)),
      })
      expect(queued?.version).toBeGreaterThan(first?.version ?? 0)
      expect(f.send).toHaveBeenCalledOnce()

      const dueAt = base + 1000 + batchWindowSeconds * 1000
      f.clock.advanceTo(dueAt - 1)
      await f.worker.flush()
      expect(f.send).toHaveBeenCalledOnce()
      const reads = f.readSummary.mock.calls.length
      f.clock.advanceTo(dueAt)
      await f.worker.flush()
      expect(f.readSummary).toHaveBeenCalledTimes(reads)
      expect(f.readIncident).not.toHaveBeenCalled()
      expect(f.send).toHaveBeenCalledTimes(2)
      expect(f.send.mock.calls[1]?.[1]).toContain("Latest fixed-window update.")
      expect(f.send.mock.calls[1]?.[1]).not.toContain("First update.")
      expect(f.send.mock.calls[1]?.[1]).toContain("合併 2 次狀態變更")
      expect(f.state().pending()).toEqual([])
      expect(f.state().get(101, "github", "incident:api-errors")?.fingerprint).toBe(
        eventFingerprint(incidentEvent(latest)),
      )
    },
  )

  it("delivers new incidents, escalations, and confirmed recoveries immediately despite grouping", async () => {
    const f = fixture({ batchWindowSeconds: 900 })
    await f.worker.poll()
    f.clock.advanceTo(base + 1000)
    const ordinary = incident({ body: "Ordinary update waiting for the batch window." })
    f.summaries.set("github", summary("github", { incidents: [ordinary] }))
    await f.worker.poll()
    expect(f.state().pending()).toHaveLength(1)
    expect(f.send).toHaveBeenCalledOnce()

    const second = incident({
      id: "second-incident",
      name: "Independent incident",
      body: "New independent incident.",
      url: "https://www.githubstatus.com/incidents/second-incident",
    })
    f.clock.advanceTo(base + 2000)
    f.summaries.set("github", summary("github", { incidents: [ordinary, second] }))
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.send.mock.calls[1]?.[1]).toContain("New independent incident.")
    expect(f.send.mock.calls[1]?.[1]).not.toContain(ordinary.body)

    const escalated = incident({ impact: "critical", body: "Severity increased." })
    f.clock.advanceTo(base + 3000)
    f.summaries.set("github", summary("github", { incidents: [escalated, second] }))
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledTimes(3)
    expect(f.send.mock.calls[2]?.[1]).toContain("Severity increased.")
    expect(f.send.mock.calls[2]?.[1]).toContain("影響：critical")
    expect(f.state().pending()).toEqual([])

    f.clock.advanceTo(base + 4000)
    f.summaries.set(
      "github",
      summary("github", {
        incidents: [incident({ impact: "critical", body: "Outdated active update." }), second],
      }),
    )
    await f.worker.poll()
    expect(f.state().pending()).toHaveLength(1)
    f.readIncident.mockResolvedValue(
      incident({ status: "resolved", impact: "none", components: [], body: "Confirmed recovery." }),
    )
    f.clock.advanceTo(base + 5000)
    f.summaries.set("github", summary("github", { incidents: [second] }))
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledTimes(4)
    expect(f.send.mock.calls[3]?.[1]).toContain("[GitHub] 已恢復")
    expect(f.send.mock.calls[3]?.[1]).toContain("Confirmed recovery.")
    expect(f.send.mock.calls[3]?.[1]).not.toContain("Outdated active update.")
    expect(f.state().get(101, "github", "incident:api-errors")?.active).toBe(0)
    expect(f.state().pending()).toEqual([])
    f.clock.advanceTo(base + 1_000_000)
    await f.worker.flush()
    expect(f.send).toHaveBeenCalledTimes(4)
  })

  it("reports an issue observed and resolved during quiet hours as occurred and recovered", async () => {
    const start = Date.parse("2030-01-01T15:00:00Z")
    const end = Date.parse("2030-01-01T22:00:00Z")
    const f = fixture(
      {
        quietHours: { timeZone: "Asia/Taipei", start: "22:00", end: "06:00" },
        batchWindowSeconds: 300,
      },
      start,
    )
    await f.worker.poll()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.state().pendingGet(101, "github", "incident:api-errors")).toMatchObject({
      initial: true,
      dueAt: end,
      change: "new",
    })
    expect(f.state().get(101, "github", "incident:api-errors")).toBeUndefined()

    f.clock.advanceTo(start + 300_000)
    f.summaries.set("github", summary("github"))
    f.readIncident.mockResolvedValue(
      incident({
        status: "resolved",
        impact: "none",
        components: [],
        body: "Resolved before delivery.",
      }),
    )
    await f.worker.poll()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.state().pendingGet(101, "github", "incident:api-errors")).toMatchObject({
      initial: true,
      dueAt: end,
      changes: 2,
      change: "resolved",
      event: { active: false },
    })
    expect(f.state().get(101, "github", "incident:api-errors")).toBeUndefined()

    f.clock.advanceTo(end - 1)
    await f.worker.flush()
    expect(f.send).not.toHaveBeenCalled()
    f.clock.advanceTo(end)
    await f.worker.flush()
    expect(f.send).toHaveBeenCalledOnce()
    const text = f.send.mock.calls[0]?.[1]
    expect(text?.split("\n")[0]).toBe("[GitHub] 期間發生並已恢復")
    expect(text).toContain("Resolved before delivery.")
    expect(text).toContain("https://www.githubstatus.com/incidents/api-errors")
    expect(f.readSummary).toHaveBeenCalledTimes(2)
    expect(f.state().get(101, "github", "incident:api-errors")?.active).toBe(0)
    expect(f.state().pending()).toEqual([])
    await f.worker.flush()
    expect(f.send).toHaveBeenCalledOnce()
  })

  it("preserves queued versions across restart and reads due deliveries without sending or polling", async () => {
    const f = fixture({ batchWindowSeconds: 60 })
    await f.worker.poll()
    f.clock.advanceTo(base + 1000)
    f.summaries.set(
      "github",
      summary("github", { incidents: [incident({ body: "Persisted deferred update." })] }),
    )
    await f.worker.poll()
    const queued = f.state().pending()
    expect(queued).toHaveLength(1)
    const closed = f.worker.close()
    expect(f.worker.close()).toBe(closed)
    await closed
    const restarted = await f.reopen()
    expect(f.state().pending()).toEqual(queued)
    f.clock.advanceTo(base + 61_000)

    const query = { offset: 0, limit: 1, chatId: 101, provider: "github" } as const
    const before = restarted.deliveries(query)
    expect(restarted.deliveries(query)).toEqual(before)
    expect(before).toMatchObject({
      total: 1,
      items: [{ chatId: 101, provider: "github", pendingCount: 1, nextDueAt: base + 61_000 }],
      sources: [{ provider: "github", lastSuccessAt: base + 1000, lastFailureAt: null }],
    })
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.readSummary).toHaveBeenCalledTimes(2)
    expect(f.readIncident).not.toHaveBeenCalled()
    expect(f.state().pending()).toEqual(queued)

    await restarted.flush()
    await restarted.flush()
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.send.mock.calls[1]?.[1]).toContain("Persisted deferred update.")
    expect(f.readSummary).toHaveBeenCalledTimes(2)
    expect(f.readIncident).not.toHaveBeenCalled()
    expect(f.state().pending()).toEqual([])
    expect(restarted.deliveries(query).items[0]).toMatchObject({
      pendingCount: 0,
      nextDueAt: null,
      lastSuccessAt: base + 61_000,
    })
    const closing = restarted.close()
    expect(restarted.close()).toBe(closing)
    await closing
  })

  it("wakes the shared loop after a settings save and flushes at the batch deadline rather than the next poll", async () => {
    const f = fixture({ batchWindowSeconds: 60, pollIntervalSeconds: 3600 })
    f.worker.start()
    f.worker.start()
    await settleUntil(() => f.clock.nextWaitAt === base + 3_600_000)
    expect(f.readSummary).toHaveBeenCalledOnce()
    expect(f.send).toHaveBeenCalledOnce()

    f.clock.advanceTo(base + 1000)
    f.summaries.set(
      "github",
      summary("github", { incidents: [incident({ body: "Update after settings wake." })] }),
    )
    f.apply((policy) => {
      policy.githubNotifications.allowedUsernames = ["fixture-reviewer"]
    })
    f.worker.wake()
    await settleUntil(() => f.clock.nextWaitAt === base + 61_000)
    expect(f.readSummary).toHaveBeenCalledTimes(2)
    expect(f.send).toHaveBeenCalledOnce()

    f.clock.advanceTo(base + 61_000)
    await settleUntil(() => f.clock.nextWaitAt === base + 3_601_000)
    expect(f.readSummary).toHaveBeenCalledTimes(2)
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.send.mock.calls[1]?.[1]).toContain("Update after settings wake.")
    expect(f.state().pending()).toEqual([])
    await f.worker.close()
    expect(f.clock.nextWaitAt).toBe(Number.POSITIVE_INFINITY)
  })

  it("wakes at the quiet-window boundary without another provider read", async () => {
    const start = Date.parse("2030-01-02T05:59:50Z")
    const end = Date.parse("2030-01-02T06:00:00Z")
    const f = fixture({ quietHours: { timeZone: "UTC", start: "22:00", end: "06:00" } }, start)
    f.worker.start()
    await settleUntil(() => f.clock.nextWaitAt === end)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.readSummary).toHaveBeenCalledOnce()
    f.clock.advanceTo(end)
    await settleUntil(() => f.clock.nextWaitAt === start + 3_600_000)
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.readSummary).toHaveBeenCalledOnce()
    expect(f.state().pending()).toEqual([])
  })
})

describe("fresh observations and delivery boundaries", () => {
  it("cancels a queued active incident that fresh component data positively excludes", async () => {
    const f = fixture(
      {
        componentSelections: { github: ["api"] },
        quietHours: { timeZone: "UTC", start: "12:00", end: "13:00" },
      },
      base + 30 * 60_000,
    )
    const api = { id: "api", name: "API", status: "operational" }
    const other = { id: "other", name: "Other", status: "operational" }
    f.summaries.set(
      "github",
      summary("github", { components: [api, other], incidents: [incident()] }),
    )
    await f.worker.poll()
    expect(f.state().pending()).toHaveLength(1)
    f.clock.advanceTo(base + 59 * 60_000)
    f.summaries.set(
      "github",
      summary("github", {
        components: [api, other],
        incidents: [incident({ components: [other], body: "Now only an unrelated component." })],
      }),
    )
    await f.worker.poll()
    expect(f.state().pending()).toEqual([])
    f.clock.advanceTo(base + 60 * 60_000)
    await f.worker.flush()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.state().active("github")).toEqual([])
  })

  it("replaces a deferred aggregate with eligible covering detail instead of sending both", async () => {
    const f = fixture({ quietHours: { timeZone: "UTC", start: "12:00", end: "13:00" } })
    const components = [{ id: "api", name: "API", status: "partial_outage" }]
    f.summaries.set("github", summary("github", { indicator: "major", components }))
    await f.worker.poll()
    expect(f.state().pending()[0]?.eventId).toBe("summary")
    f.summaries.set(
      "github",
      summary("github", { indicator: "major", components, incidents: [incident()] }),
    )
    await f.worker.poll()
    expect(
      f
        .state()
        .pending()
        .map((row) => row.eventId),
    ).toEqual(["incident:api-errors"])
    f.clock.advanceTo(base + 60 * 60_000)
    await f.worker.flush()
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.send.mock.calls[0]?.[1]).not.toContain("GitHub service status")
  })

  it("holds an old active aggregate when a fresh catalog cannot prove selected state", async () => {
    const f = fixture({
      componentSelections: { github: ["api"] },
      quietHours: { timeZone: "UTC", start: "12:00", end: "13:00" },
    })
    f.summaries.set(
      "github",
      summary("github", { components: [{ id: "api", name: "API", status: "partial_outage" }] }),
    )
    await f.worker.poll()
    const pending = f.state().pending()[0]
    expect(pending).toBeDefined()
    f.summaries.set("github", summary("github"))
    f.clock.advanceTo(base + 59 * 60_000)
    await f.worker.poll()
    f.clock.advanceTo(base + 60 * 60_000)
    await f.worker.flush()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.state().pending()).toHaveLength(1)
    expect(f.state().active("github")).toEqual([])
    f.summaries.set(
      "github",
      summary("github", { components: [{ id: "api", name: "API", status: "operational" }] }),
    )
    f.clock.advanceTo(base + 61 * 60_000)
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.send.mock.calls[0]?.[1]).toContain("期間發生並已恢復")
  })

  it.each(["settled attempt", "transport spacing"] as const)(
    "rechecks quiet hours after %s",
    async (boundary) => {
      const f = fixture(
        { quietHours: { timeZone: "UTC", start: "12:00", end: "13:00" } },
        base - 50,
      )
      f.summaries.set(
        "github",
        summary("github", { incidents: [incident({ id: "first" }), incident({ id: "second" })] }),
      )
      if (boundary === "settled attempt")
        f.send.mockImplementationOnce(async () => {
          f.clock.advanceTo(base + 150)
        })
      await f.worker.poll()
      expect(f.send).toHaveBeenCalledOnce()
      expect(
        f
          .state()
          .pending()
          .map((row) => row.eventId),
      ).toEqual(["incident:second"])
      expect(f.state().pending()[0]?.dueAt).toBe(base + 60 * 60_000)
      expect(f.worker.deliveries({ offset: 0, limit: 100 }).items[0]?.lastFailureAt).toBeNull()
      f.clock.advanceTo(base + 60 * 60_000)
      await f.worker.flush()
      expect(f.send).toHaveBeenCalledTimes(2)
    },
  )

  it("labels a deferred qualifying peak separately from an improved lower latest impact", async () => {
    const f = fixture({
      minimumImpact: "major",
      quietHours: { timeZone: "UTC", start: "12:00", end: "13:00" },
    })
    await f.worker.poll()
    f.summaries.set(
      "github",
      summary("github", {
        incidents: [incident({ impact: "minor", body: "Latest state is minor." })],
      }),
    )
    f.clock.advanceTo(base + 59 * 60_000)
    await f.worker.poll()
    f.clock.advanceTo(base + 60 * 60_000)
    await f.worker.flush()
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.send.mock.calls[0]?.[1]).toContain("期間最高影響：major")
    expect(f.send.mock.calls[0]?.[1]).toContain("影響：minor")
    expect(f.send.mock.calls[0]?.[1]).toContain("Latest state is minor.")
    const minorOnly = fixture({ minimumImpact: "major" })
    minorOnly.summaries.set(
      "github",
      summary("github", { incidents: [incident({ impact: "minor" })] }),
    )
    await minorOnly.worker.poll()
    expect(minorOnly.send).not.toHaveBeenCalled()
    expect(minorOnly.state().pending()).toEqual([])
  })

  it("one cancelled catalog consumer cannot abort another or poison its successful cache", async () => {
    const f = fixture({ enabled: false })
    const result = deferred<StatusSummary>()
    let shared: AbortSignal | undefined
    f.readSummary.mockImplementation(async (_provider, options) => {
      shared = options?.signal
      return result.promise
    })
    const first = new AbortController()
    const second = new AbortController()
    const cancelled = expect(f.worker.components("github", first.signal)).rejects.toMatchObject({
      name: "AbortError",
    })
    const waiting = f.worker.components("github", second.signal)
    first.abort()
    await cancelled
    expect(shared?.aborted).toBe(false)
    result.resolve(
      summary("github", { components: [{ id: "api", name: "API", status: "operational" }] }),
    )
    expect(await waiting).toMatchObject({ stale: false, error: null })
    expect(await f.worker.components("github", second.signal)).toMatchObject({
      stale: false,
      error: null,
    })
    expect(f.readSummary).toHaveBeenCalledOnce()
  })

  it("last-consumer cancellation permits a fresh catalog read without a negative cache", async () => {
    const f = fixture({ enabled: false })
    f.readSummary.mockImplementationOnce(
      async (_provider, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          })
        }),
    )
    const first = new AbortController()
    const cancelled = expect(f.worker.components("github", first.signal)).rejects.toMatchObject({
      name: "AbortError",
    })
    first.abort()
    await cancelled
    const result = await f.worker.components("github", new AbortController().signal)
    expect(result).toMatchObject({ stale: false, error: null })
    expect(f.readSummary).toHaveBeenCalledTimes(2)
  })
})

describe("service status queue delivery controls", () => {
  it("retries a failed chat independently and persists separate failure and success timestamps", async () => {
    const f = fixture({ chatIds: [101, -202] })
    let failed = false
    f.send.mockImplementation(async (chatId) => {
      if (chatId === 101 && !failed) {
        failed = true
        throw new Error("Sensitive transport detail must not appear in delivery results")
      }
    })
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.state().get(-202, "github", "incident:api-errors")?.active).toBe(1)
    expect(f.state().get(101, "github", "incident:api-errors")).toBeUndefined()
    const pending = f.state().pendingGet(101, "github", "incident:api-errors")
    expect(pending).toBeDefined()
    const failure = f.worker.deliveries({ offset: 0, limit: 10, chatId: 101 }).items[0]
    expect(failure).toMatchObject({
      lastSuccessAt: null,
      lastError: "delivery_failed",
      pendingCount: 1,
      nextDueAt: pending?.dueAt,
    })
    expect(failure?.lastFailureAt).toBeTypeOf("number")
    expect(pending?.dueAt).toBe((failure?.lastFailureAt ?? 0) + 60_000)
    expect(JSON.stringify(f.worker.deliveries({ offset: 0, limit: 10 }))).not.toContain(
      "Sensitive transport detail",
    )

    const dueAt = pending?.dueAt ?? 0
    f.clock.advanceTo(dueAt - 1)
    await f.worker.flush()
    expect(f.send).toHaveBeenCalledTimes(2)
    f.clock.advanceTo(dueAt)
    await f.worker.flush()
    expect(f.send.mock.calls.slice(2).map(([chatId]) => chatId)).toEqual([101])
    expect(f.readSummary).toHaveBeenCalledOnce()
    expect(f.readIncident).not.toHaveBeenCalled()
    expect(f.state().pending()).toEqual([])
    expect(f.state().get(101, "github", "incident:api-errors")?.active).toBe(1)
    expect(f.worker.deliveries({ offset: 0, limit: 10, chatId: 101 }).items[0]).toMatchObject({
      lastSuccessAt: dueAt,
      lastFailureAt: failure?.lastFailureAt,
      lastError: "delivery_failed",
      pendingCount: 0,
    })
    await f.worker.flush()
    expect(f.send).toHaveBeenCalledTimes(3)
  })

  it("keeps unchanged queue rows across unrelated policy revisions and cancels only a changed chat rule", async () => {
    const f = fixture({ batchWindowSeconds: 60, chatIds: [101, -202] })
    await f.worker.poll()
    f.clock.advanceTo(base + 1000)
    f.summaries.set(
      "github",
      summary("github", { incidents: [incident({ body: "Queued update." })] }),
    )
    await f.worker.poll()
    const queued = f.state().pending()
    expect(queued).toHaveLength(2)
    const revision = f.store.snapshot().revision
    f.apply((policy) => {
      policy.githubNotifications.allowedUsernames = ["fixture-reviewer"]
    })
    expect(f.store.snapshot().revision).toBeGreaterThan(revision)
    await f.worker.flush()
    expect(f.state().pending()).toEqual(queued)
    expect(f.send).toHaveBeenCalledTimes(2)

    f.configure({ chatOverrides: { "101": { componentSelections: { github: [] } } } })
    await f.worker.flush()
    expect(f.state().pending()).toEqual(queued.filter((row) => row.chatId === -202))
    expect(f.state().get(101, "github", "incident:api-errors")?.active).toBe(1)
    f.clock.advanceTo(base + 61_000)
    await f.worker.flush()
    expect(f.send.mock.calls.slice(2).map(([chatId]) => chatId)).toEqual([-202])
    expect(f.send.mock.calls[2]?.[1]).toContain("Queued update.")
    expect(f.state().pending()).toEqual([])
    expect(f.readSummary).toHaveBeenCalledTimes(2)
    expect(f.send.mock.calls.some(([, text]) => text.includes("已恢復"))).toBe(false)
  })

  it.each([
    "disabled",
    "destination removed",
    "sources empty",
    "components empty",
    "threshold changed",
  ])("cancels deferred work without delivery or recovery when %s", async (change) => {
    const f = fixture({ batchWindowSeconds: 60 })
    await f.worker.poll()
    f.clock.advanceTo(base + 1000)
    f.summaries.set(
      "github",
      summary("github", { incidents: [incident({ body: "Revoked deferred update." })] }),
    )
    await f.worker.poll()
    expect(f.state().pending()).toHaveLength(1)
    if (change === "disabled") f.configure({ enabled: false })
    if (change === "destination removed") f.configure({ chatIds: [], chatOverrides: {} })
    if (change === "sources empty") f.configure({ chatOverrides: { "101": { providers: [] } } })
    if (change === "components empty")
      f.configure({ chatOverrides: { "101": { componentSelections: { github: [] } } } })
    if (change === "threshold changed")
      f.configure({ chatOverrides: { "101": { minimumImpact: "critical" } } })
    f.clock.advanceTo(base + 61_000)
    await f.worker.flush()
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.state().pending()).toEqual([])
    expect(f.state().get(101, "github", "incident:api-errors")?.active).not.toBe(0)
    expect(f.readSummary).toHaveBeenCalledTimes(2)
    expect(f.readIncident).not.toHaveBeenCalled()
  })

  it("does not flush a failed source or invent recovery when summary and terminal-detail reads fail", async () => {
    const f = fixture({ batchWindowSeconds: 60 })
    await f.worker.poll()
    f.clock.advanceTo(base + 1000)
    f.summaries.set(
      "github",
      summary("github", { incidents: [incident({ body: "Deferred active update." })] }),
    )
    await f.worker.poll()
    const checkpoint = f.state().get(101, "github", "incident:api-errors")
    f.clock.advanceTo(base + 61_000)
    f.readSummary.mockRejectedValueOnce(new Error("Synthetic source failure"))
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.readIncident).not.toHaveBeenCalled()
    expect(f.state().get(101, "github", "incident:api-errors")).toEqual(checkpoint)
    expect(f.state().pendingGet(101, "github", "incident:api-errors")?.dueAt).toBe(base + 121_000)
    const results = f.worker.deliveries({ offset: 0, limit: 10 })
    expect(results.sources).toEqual([
      expect.objectContaining({
        provider: "github",
        lastSuccessAt: base + 1000,
        lastFailureAt: base + 61_000,
        lastError: "source_unavailable",
      }),
    ])
    expect(results.items[0]).toMatchObject({ lastFailureAt: null, lastError: null })

    f.clock.advanceTo(base + 121_000)
    await f.worker.flush()
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.readSummary).toHaveBeenCalledTimes(3)
    f.summaries.set("github", summary("github"))
    await f.worker.poll()
    expect(f.readIncident).toHaveBeenCalledOnce()
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.state().get(101, "github", "incident:api-errors")).toEqual(checkpoint)

    f.readIncident.mockResolvedValue(
      incident({ status: "resolved", impact: "none", components: [], body: "Verified recovery." }),
    )
    f.clock.advanceTo(base + 122_000)
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.send.mock.calls[1]?.[1]).toContain("[GitHub] 已恢復")
    expect(f.send.mock.calls[1]?.[1]).toContain("Verified recovery.")
    expect(f.send.mock.calls[1]?.[1]).not.toContain("Deferred active update.")
    expect(f.state().pending()).toEqual([])
  })

  it("acknowledges only the version sent and retains an update admitted during the external send", async () => {
    const f = fixture()
    const entered = deferred<void>()
    const release = deferred<void>()
    f.send.mockImplementationOnce(async () => {
      entered.resolve(undefined)
      await release.promise
    })
    const polling = f.worker.poll()
    await entered.promise
    const sent = f.state().pendingGet(101, "github", "incident:api-errors")
    if (!sent) throw new Error("The queue must be committed before transport starts")
    expect(f.state().get(101, "github", "incident:api-errors")).toBeUndefined()
    const event = incidentEvent(incident({ body: "Newer update admitted during transport." }))
    try {
      expect(
        f.state().admit({
          ...sent,
          event,
          fingerprint: eventFingerprint(event),
          change: "update",
          changes: sent.changes + 1,
          dueAt: base + 60_000,
          initial: false,
        }),
      ).toBe(true)
    } finally {
      release.resolve(undefined)
    }
    await polling

    const newer = f.state().pendingGet(101, "github", "incident:api-errors")
    expect(newer?.version).toBeGreaterThan(sent.version)
    expect(newer?.event.body).toBe("Newer update admitted during transport.")
    expect(f.state().get(101, "github", "incident:api-errors")?.fingerprint).toBe(sent.fingerprint)
    expect(f.send.mock.calls[0]?.[1]).toContain("Initial API incident.")
    expect(f.send.mock.calls[0]?.[1]).not.toContain("Newer update admitted during transport.")
    f.clock.advanceTo(base + 60_000)
    await f.worker.flush()
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.send.mock.calls[1]?.[1]).toContain("Newer update admitted during transport.")
    expect(f.state().get(101, "github", "incident:api-errors")?.fingerprint).toBe(
      eventFingerprint(event),
    )
    expect(f.state().pending()).toEqual([])
    expect(f.readSummary).toHaveBeenCalledOnce()
    expect(f.readIncident).not.toHaveBeenCalled()
  })

  it("splits queued summaries below 1000 code points at complete event boundaries and retains every source link", async () => {
    const start = Date.parse("2030-01-02T05:00:00Z")
    const end = Date.parse("2030-01-02T06:00:00Z")
    const f = fixture({ quietHours: { timeZone: "UTC", start: "22:00", end: "06:00" } }, start)
    const incidents = Array.from({ length: 7 }, (_, index) =>
      incident({
        id: `batch-${index}`,
        name: `Batch event ${index}`,
        body: `Event ${index}: ${"📡".repeat(index < 2 ? 40 : 450)}`,
        url: `https://www.githubstatus.com/incidents/batch-${index}`,
      }),
    )
    f.summaries.set("github", summary("github", { incidents }))
    await f.worker.poll()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.state().pending()).toHaveLength(incidents.length)
    f.clock.advanceTo(end)
    await f.worker.flush()

    const messages = f.send.mock.calls.map(([, text]) => text)
    expect(messages.length).toBeGreaterThan(1)
    expect(messages.some((message) => message.split("\n\n").length > 1)).toBe(true)
    for (const message of messages) expect(Array.from(message).length).toBeLessThan(1000)
    const completeEvents = incidents.map((entry) =>
      formatStatusNotification("github", incidentEvent(entry), "new"),
    )
    expect(messages.flatMap((message) => message.split("\n\n")).sort()).toEqual(
      completeEvents.sort(),
    )
    for (const entry of incidents) {
      expect(messages.filter((message) => message.includes(entry.url))).toHaveLength(1)
      expect(f.state().get(101, "github", `incident:${entry.id}`)?.active).toBe(1)
    }
    expect(f.state().pending()).toEqual([])
    expect(f.readSummary).toHaveBeenCalledOnce()
    expect(f.readIncident).not.toHaveBeenCalled()
  })
})
