import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { initialStatusNotifications, type StatusNotifications } from "@narumitw/sumire-policy"
import type {
  readStatusIncident,
  readStatusSummary,
  StatusIncident,
  StatusProviderId,
  StatusSummary,
} from "@narumitw/sumire-status-page"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AdminStore } from "../src/admin/store.js"
import { eventFingerprint, incidentEvent } from "../src/service-status/events.js"
import { StatusNotificationWorker } from "../src/service-status/runtime.js"
import { StatusDeliveryState } from "../src/service-status/state.js"

vi.mock("node:timers/promises", async (importOriginal) => {
  const timers = await importOriginal<typeof import("node:timers/promises")>()
  return { ...timers, setTimeout: vi.fn(timers.setTimeout) }
})

const cleanup: Array<() => Promise<void>> = []
type Send = ConstructorParameters<typeof StatusNotificationWorker>[0]["send"]

afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close()
  } finally {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  }
})

function incident(overrides: Partial<StatusIncident> = {}): StatusIncident {
  return {
    id: "api-errors",
    name: "API errors",
    status: "investigating",
    impact: "major",
    url: "https://www.githubstatus.com/incidents/api-errors",
    updatedAt: "2030-01-01T00:00:00Z",
    body: "We are investigating increased API errors.",
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

function untilAborted<T>(signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return Promise.reject(new Error("An abort signal is required"))
  return new Promise((_, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
}

function fixture(overrides: Partial<StatusNotifications> = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sumire-status-worker-"))
  const file = path.join(directory, "admin.sqlite")
  let store = new AdminStore(file, 42)
  const workers: StatusNotificationWorker[] = []
  const summaries = new Map<StatusProviderId, StatusSummary>([
    ["github", summary("github", { incidents: [incident()] })],
  ])
  const readSummary = vi.fn<typeof readStatusSummary>(async (provider) =>
    structuredClone(summaries.get(provider) ?? summary(provider)),
  )
  const readIncident = vi.fn<typeof readStatusIncident>().mockRejectedValue(new Error("HTTP 404"))
  const send = vi.fn<Send>().mockResolvedValue(undefined)
  const logger = { warn: vi.fn() }
  const configure = (settings: Partial<StatusNotifications>, apply = true) => {
    const before = store.snapshot()
    const policy = before.policy
    policy.statusNotifications = { ...policy.statusNotifications, ...settings }
    store.save(policy, before.revision, "42")
    if (apply) store.applied(store.snapshot().revision, true)
  }
  configure({
    ...initialStatusNotifications(),
    enabled: true,
    providers: ["github"],
    chatIds: [101],
    pollIntervalSeconds: 90,
    ...overrides,
  })
  const create = () => {
    const worker = new StatusNotificationWorker({ store, readSummary, readIncident, send, logger })
    workers.push(worker)
    return worker
  }
  const worker = create()
  cleanup.push(async () => {
    await Promise.all(workers.map((item) => item.close()))
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    worker,
    summaries,
    readSummary,
    readIncident,
    send,
    logger,
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

describe("service status delivery", () => {
  it.each(["disabled", "pending", "failed", "stale", "no providers", "no chats"])(
    "does no external I/O with %s settings",
    async (condition) => {
      const f = fixture()
      if (condition === "disabled") f.configure({ enabled: false })
      if (condition === "pending") f.configure({}, false)
      if (condition === "failed") f.store.applied(f.store.snapshot().revision, false)
      if (condition === "stale")
        f.store.db.exec("UPDATE settings SET applied=revision-1 WHERE id=1")
      if (condition === "no providers") f.configure({ providers: [] })
      if (condition === "no chats") f.configure({ chatIds: [] })

      await expect(f.worker.poll()).resolves.toBe(60)
      expect(f.readSummary).not.toHaveBeenCalled()
      expect(f.readIncident).not.toHaveBeenCalled()
      expect(f.send).not.toHaveBeenCalled()
      expect(f.store.db.prepare("SELECT * FROM status_deliveries").all()).toEqual([])
    },
  )

  it("does not announce a healthy baseline or historical resolved incidents", async () => {
    const f = fixture()
    f.summaries.set("github", summary("github", { incidents: [incident({ status: "resolved" })] }))
    await expect(f.worker.poll()).resolves.toBe(90)
    await f.worker.poll()
    expect(f.readSummary).toHaveBeenCalledTimes(2)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.readIncident).not.toHaveBeenCalled()
    expect(f.state().active("github")).toEqual([])
  })

  it("retries only failed targets and deduplicates each destination across database reopens", async () => {
    const f = fixture({ chatIds: [101, -202] })
    f.send
      .mockImplementationOnce(async () => {})
      .mockRejectedValueOnce(new Error("Telegram unavailable"))
    await f.worker.poll()
    expect(f.send.mock.calls.map(([chatId]) => chatId)).toEqual([101, -202])
    expect(f.state().get(101, "github", "incident:api-errors")?.active).toBe(1)
    expect(f.state().get(-202, "github", "incident:api-errors")).toBeUndefined()
    expect(f.logger.warn).toHaveBeenCalledOnce()

    f.send.mockClear()
    const restarted = await f.reopen()
    await restarted.poll()
    expect(f.send.mock.calls.map(([chatId]) => chatId)).toEqual([-202])
    expect(f.state().get(-202, "github", "incident:api-errors")?.active).toBe(1)
    await restarted.poll()
    expect(f.send).toHaveBeenCalledOnce()

    f.send.mockClear()
    const reopenedAgain = await f.reopen()
    await reopenedAgain.poll()
    expect(f.send).not.toHaveBeenCalled()
    f.summaries.set(
      "github",
      summary("github", { incidents: [incident({ body: "A fix is deployed." })] }),
    )
    await reopenedAgain.poll()
    expect(f.send.mock.calls.map(([chatId]) => chatId)).toEqual([101, -202])
    expect(f.send.mock.calls.every(([, text]) => text.includes("事件更新"))).toBe(true)
  })

  it("announces current incidents, material updates, and confirmed recovery only once", async () => {
    const f = fixture()
    await f.worker.poll()
    f.summaries.set(
      "github",
      summary("github", {
        incidents: [incident({ status: "monitoring", body: "A fix is being monitored." })],
      }),
    )
    await f.worker.poll()
    await f.worker.poll()
    f.summaries.set(
      "github",
      summary("github", {
        incidents: [incident({ status: "resolved", impact: "none", body: "Service restored." })],
      }),
    )
    await f.worker.poll()
    await f.worker.poll()

    expect(f.send.mock.calls.map(([, text]) => text.split("\n")[0])).toEqual([
      "[GitHub] 服務異常",
      "[GitHub] 事件更新",
      "[GitHub] 已恢復",
    ])
    expect(f.send.mock.calls[1]?.[1]).toContain("A fix is being monitored.")
    expect(f.state().get(101, "github", "incident:api-errors")?.active).toBe(0)
    expect(f.readIncident).not.toHaveBeenCalled()
  })

  it("filters low severity, announces escalation, and does not filter recovery", async () => {
    const f = fixture({ minimumImpact: "major" })
    f.summaries.set("github", summary("github", { incidents: [incident({ impact: "minor" })] }))
    await f.worker.poll()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.state().get(101, "github", "incident:api-errors")).toBeUndefined()
    f.summaries.set("github", summary("github", { incidents: [incident({ impact: "major" })] }))
    await f.worker.poll()
    f.summaries.set("github", summary("github", { incidents: [incident({ impact: "critical" })] }))
    await f.worker.poll()
    f.summaries.set(
      "github",
      summary("github", { incidents: [incident({ status: "resolved", impact: "none" })] }),
    )
    await f.worker.poll()
    expect(f.send.mock.calls.map(([, text]) => text.split("\n")[0])).toEqual([
      "[GitHub] 服務異常",
      "[GitHub] 事件更新",
      "[GitHub] 已恢復",
    ])
    expect(f.send.mock.calls[1]?.[1]).toContain("影響：critical")
  })

  it("does not resend for timestamps or incident and component array order", async () => {
    const f = fixture()
    const first = incident({
      components: [
        { id: "api", name: "API", status: "partial_outage" },
        { id: "web", name: "Web", status: "degraded_performance" },
      ],
    })
    const second = incident({ id: "web-errors", name: "Web errors" })
    f.summaries.set("github", summary("github", { incidents: [first, second] }))
    await f.worker.poll()
    f.summaries.set(
      "github",
      summary("github", {
        components: [{ id: "unrelated", name: "Other service", status: "operational" }],
        incidents: [
          { ...second, updatedAt: "2030-01-02T00:00:00Z" },
          {
            ...first,
            updatedAt: "2030-01-02T00:00:00Z",
            components: [...first.components].reverse(),
          },
        ],
      }),
    )
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledTimes(2)
  })

  it("does not duplicate detailed incidents with an aggregate alert", async () => {
    const f = fixture()
    f.summaries.set(
      "github",
      summary("github", {
        indicator: "major",
        description: "Partial system outage",
        components: [{ id: "api", name: "API", status: "partial_outage" }],
        incidents: [incident()],
      }),
    )
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.send.mock.calls[0]?.[1]).toContain("API errors")
    expect(f.state().get(101, "github", "summary")).toBeUndefined()
    f.summaries.set(
      "github",
      summary("github", {
        indicator: "major",
        description: "Partial system outage",
        components: [{ id: "api", name: "API", status: "partial_outage" }],
      }),
    )
    f.readIncident.mockResolvedValue(incident())
    await f.worker.poll()
    expect(f.readIncident).toHaveBeenCalledOnce()
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.state().get(101, "github", "summary")).toBeUndefined()
  })

  it.each(["minor", "none"] as const)(
    "tracks OpenAI component-only degradation and healthy recovery with top indicator %s",
    async (indicator) => {
      const f = fixture({ providers: ["openai"] })
      const degraded = summary("openai", {
        indicator,
        description: "API requests are degraded.",
        components: [{ id: "api", name: "API", status: "partial_outage" }],
      })
      f.summaries.set("openai", degraded)
      await f.worker.poll()
      expect(f.send.mock.calls[0]?.[1]).toContain("[OpenAI] 服務異常")
      expect(f.send.mock.calls[0]?.[1]).toContain("影響：major")
      expect(f.state().get(101, "openai", "summary")?.active).toBe(1)

      f.summaries.set("openai", {
        ...degraded,
        indicator: "none",
        components: [
          { id: "other", name: "Unrelated healthy component", status: "operational" },
          ...degraded.components,
        ],
      })
      await f.worker.poll()
      expect(f.send).toHaveBeenCalledOnce()
      f.summaries.set(
        "openai",
        summary("openai", {
          components: [{ id: "api", name: "API", status: "operational" }],
        }),
      )
      await f.worker.poll()
      await f.worker.poll()
      expect(f.send).toHaveBeenCalledTimes(2)
      expect(f.send.mock.calls[1]?.[1]).toContain("[OpenAI] 已恢復")
      expect(f.state().get(101, "openai", "summary")?.active).toBe(0)
      expect(f.readIncident).not.toHaveBeenCalled()
    },
  )

  it.each(["resolved", "postmortem", "completed"])(
    "confirms a missing incident through detail status %s before recovery",
    async (status) => {
      const f = fixture()
      await f.worker.poll()
      f.summaries.set("github", summary("github"))
      f.readIncident.mockResolvedValue(incident())
      await f.worker.poll()
      expect(f.send).toHaveBeenCalledOnce()
      expect(f.state().get(101, "github", "incident:api-errors")?.active).toBe(1)
      f.readIncident.mockResolvedValue(incident({ status, impact: "none" }))
      await f.worker.poll()
      await f.worker.poll()
      expect(f.readIncident).toHaveBeenCalledTimes(2)
      expect(f.readIncident).toHaveBeenCalledWith("github", "api-errors", {
        signal: expect.any(AbortSignal),
      })
      expect(f.send).toHaveBeenCalledTimes(2)
      expect(f.send.mock.calls[1]?.[1]).toContain("已恢復")
      expect(f.state().get(101, "github", "incident:api-errors")?.active).toBe(0)
    },
  )

  it("does not infer recovery from detail errors, 404s, identity mismatches, or failed summaries", async () => {
    const f = fixture()
    await f.worker.poll()
    const original = f.state().get(101, "github", "incident:api-errors")
    f.summaries.set("github", summary("github"))
    f.readIncident
      .mockRejectedValueOnce(new Error("Status page request failed (HTTP 404)"))
      .mockRejectedValueOnce(new Error("Upstream unavailable"))
      .mockResolvedValueOnce(incident({ id: "different-incident", status: "resolved" }))
    await f.worker.poll()
    await f.worker.poll()
    await f.worker.poll()
    f.readSummary.mockRejectedValueOnce(new Error("Summary unavailable"))
    await f.worker.poll()
    expect(f.readIncident).toHaveBeenCalledTimes(3)
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.state().get(101, "github", "incident:api-errors")).toEqual(original)
    expect(f.logger.warn).toHaveBeenCalledTimes(4)
  })

  it("keeps another provider available when a summary or recovery detail fails", async () => {
    const f = fixture({ providers: ["github", "openai"] })
    f.readSummary.mockRejectedValueOnce(new Error("GitHub summary unavailable"))
    f.summaries.set(
      "openai",
      summary("openai", {
        incidents: [incident({ url: "https://status.openai.com/incidents/api-errors" })],
      }),
    )
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.send.mock.calls[0]?.[1]).toContain("[OpenAI]")
    await f.worker.poll()
    expect(f.state().get(101, "github", "incident:api-errors")?.active).toBe(1)
    f.summaries.set("github", summary("github"))
    f.summaries.set(
      "openai",
      summary("openai", { incidents: [incident({ body: "OpenAI mitigation deployed." })] }),
    )
    f.send.mockClear()
    await f.worker.poll()
    expect(f.readIncident).toHaveBeenCalledWith("github", "api-errors", expect.anything())
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.send.mock.calls[0]?.[1]).toContain("OpenAI mitigation deployed.")
    expect(f.state().get(101, "github", "incident:api-errors")?.active).toBe(1)
  })

  it("does not acknowledge a failed update and retries the same content", async () => {
    const f = fixture()
    await f.worker.poll()
    const original = f.state().get(101, "github", "incident:api-errors")
    const updated = incident({ body: "Mitigation deployed." })
    f.summaries.set("github", summary("github", { incidents: [updated] }))
    f.send.mockRejectedValueOnce(new Error("Telegram unavailable"))
    await f.worker.poll()
    expect(f.state().get(101, "github", "incident:api-errors")).toEqual(original)
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledTimes(3)
    expect(f.state().get(101, "github", "incident:api-errors")?.fingerprint).toBe(
      eventFingerprint(incidentEvent(updated)),
    )
  })

  it("acknowledges suppressed update and recovery transitions without replay after enabling them", async () => {
    const f = fixture({ notifyUpdates: false, notifyResolved: false })
    await f.worker.poll()
    const updated = incident({ status: "monitoring", body: "A fix is deployed." })
    f.summaries.set("github", summary("github", { incidents: [updated] }))
    await f.worker.poll()
    expect(f.state().get(101, "github", "incident:api-errors")?.fingerprint).toBe(
      eventFingerprint(incidentEvent(updated)),
    )
    f.configure({ notifyUpdates: true })
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledOnce()

    f.summaries.set(
      "github",
      summary("github", { incidents: [incident({ status: "resolved", impact: "none" })] }),
    )
    await f.worker.poll()
    expect(f.state().get(101, "github", "incident:api-errors")?.active).toBe(0)
    f.configure({ notifyResolved: true })
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledOnce()
    f.summaries.set(
      "github",
      summary("github", { incidents: [incident({ body: "A new outage is being investigated." })] }),
    )
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.send.mock.calls[1]?.[1]).toContain("服務異常")
  })

  it("skips maintenance when disabled and emits only the detailed maintenance when enabled", async () => {
    const f = fixture({ minimumImpact: "critical" })
    const maintenance = incident({
      impact: "maintenance",
      status: "scheduled",
      scheduledFor: "2030-01-02T08:00:00+08:00",
      scheduledUntil: "2030-01-02T09:00:00+08:00",
    })
    f.summaries.set(
      "github",
      summary("github", {
        components: [{ id: "api", name: "API", status: "under_maintenance" }],
        maintenances: [maintenance],
      }),
    )
    await f.worker.poll()
    expect(f.send).not.toHaveBeenCalled()
    expect(f.readIncident).not.toHaveBeenCalled()
    f.configure({ includeMaintenance: true })
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.send.mock.calls[0]?.[1]).toContain("計畫性維護")
    expect(f.send.mock.calls[0]?.[1]).toContain("2030-01-02T00:00:00.000Z")
    expect(f.state().get(101, "github", "summary")).toBeUndefined()
    expect(f.state().get(101, "github", "maintenance:api-errors")?.maintenance).toBe(1)

    f.configure({ includeMaintenance: false })
    f.summaries.set("github", summary("github"))
    f.readIncident.mockResolvedValue(incident({ ...maintenance, status: "completed" }))
    await f.worker.poll()
    expect(f.readIncident).not.toHaveBeenCalled()
    expect(f.state().get(101, "github", "maintenance:api-errors")?.active).toBe(1)
    f.configure({ includeMaintenance: true })
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.send.mock.calls[1]?.[1]).toContain("已恢復")
    expect(f.state().get(101, "github", "maintenance:api-errors")?.active).toBe(0)
  })

  it("recognizes maintenance returned in the incidents array", async () => {
    const f = fixture()
    f.summaries.set(
      "github",
      summary("github", {
        incidents: [incident({ impact: "maintenance" })],
        components: [{ id: "api", name: "API", status: "under_maintenance" }],
      }),
    )
    await f.worker.poll()
    expect(f.send).not.toHaveBeenCalled()
    f.configure({ includeMaintenance: true })
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.send.mock.calls[0]?.[1]).toContain("計畫性維護")
    expect(f.state().get(101, "github", "maintenance:api-errors")?.active).toBe(1)
    expect(f.state().get(101, "github", "summary")).toBeUndefined()
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledOnce()
  })

  it("removes revoked destinations and starts a new checkpoint if they are selected again", async () => {
    const f = fixture({ chatIds: [101, -202] })
    await f.worker.poll()
    f.configure({ chatIds: [101] })
    await f.worker.poll()
    expect(f.state().get(-202, "github", "incident:api-errors")).toBeUndefined()
    f.configure({ chatIds: [101, -202] })
    f.send.mockClear()
    await f.worker.poll()
    expect(f.send.mock.calls.map(([chatId]) => chatId)).toEqual([-202])
  })

  it("retains a degraded aggregate for unknown component status until explicit healthy recovery", async () => {
    const f = fixture({ providers: ["openai"] })
    f.summaries.set(
      "openai",
      summary("openai", {
        components: [{ id: "api", name: "API", status: "partial_outage" }],
      }),
    )
    await f.worker.poll()
    const original = f.state().get(101, "openai", "summary")
    f.summaries.set(
      "openai",
      summary("openai", {
        components: [{ id: "api", name: "API", status: "unknown_provider_status" }],
      }),
    )
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.state().get(101, "openai", "summary")).toEqual(original)
    f.summaries.set(
      "openai",
      summary("openai", {
        components: [{ id: "api", name: "API", status: "operational" }],
      }),
    )
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.send.mock.calls[1]?.[1]).toContain("已恢復")
    expect(f.state().get(101, "openai", "summary")?.active).toBe(0)
  })

  it("does not infer maintenance recovery on exclusion or suppress a new outage as an update", async () => {
    const f = fixture({ providers: ["openai"], includeMaintenance: true, notifyUpdates: false })
    f.summaries.set(
      "openai",
      summary("openai", {
        components: [{ id: "api", name: "API", status: "under_maintenance" }],
      }),
    )
    await f.worker.poll()
    const original = f.state().get(101, "openai", "summary")
    expect(original?.maintenance).toBe(1)
    f.configure({ includeMaintenance: false })
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.state().get(101, "openai", "summary")).toEqual(original)
    f.summaries.set(
      "openai",
      summary("openai", {
        components: [{ id: "api", name: "API", status: "major_outage" }],
      }),
    )
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.send.mock.calls[1]?.[1]).toContain("服務異常")
    expect(f.state().get(101, "openai", "summary")?.maintenance).toBe(0)
    f.configure({ includeMaintenance: true })
    f.summaries.set(
      "openai",
      summary("openai", {
        components: [{ id: "api", name: "API", status: "under_maintenance" }],
      }),
    )
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledTimes(3)
    expect(f.send.mock.calls[2]?.[1]).toContain("計畫性維護")
  })

  it.each(["empty chats", "empty providers", "disabled selection"])(
    "cleans revoked checkpoints with applied %s without external I/O",
    async (condition) => {
      const f = fixture({ chatIds: [101, -202] })
      f.state().acknowledge(101, "github", "incident:api-errors", "first", true, false, Date.now())
      f.state().acknowledge(
        -202,
        "github",
        "incident:api-errors",
        "second",
        true,
        false,
        Date.now(),
      )
      if (condition === "empty chats") f.configure({ chatIds: [] })
      if (condition === "empty providers") f.configure({ providers: [] })
      if (condition === "disabled selection") f.configure({ enabled: false, chatIds: [101] })
      await expect(f.worker.poll()).resolves.toBe(60)
      expect(f.state().get(-202, "github", "incident:api-errors")).toBeUndefined()
      expect(f.state().active("github")).toHaveLength(condition === "disabled selection" ? 1 : 0)
      expect(f.readSummary).not.toHaveBeenCalled()
      expect(f.readIncident).not.toHaveBeenCalled()
      expect(f.send).not.toHaveBeenCalled()
    },
  )

  it.each(["pending", "failed"])("does not prune under %s settings", async (status) => {
    const f = fixture()
    f.state().acknowledge(101, "github", "incident:api-errors", "keep", true, false, Date.now())
    f.configure({ chatIds: [] }, false)
    if (status === "failed") f.store.applied(f.store.snapshot().revision, false)
    await f.worker.poll()
    expect(f.state().get(101, "github", "incident:api-errors")?.fingerprint).toBe("keep")
    expect(f.readSummary).not.toHaveBeenCalled()
    expect(f.send).not.toHaveBeenCalled()
  })

  it("bounds recovery scans and rotates past permanently missing incidents", async () => {
    const f = fixture()
    f.summaries.set("github", summary("github"))
    for (let index = 0; index < 13; index++) {
      const event = incidentEvent(incident({ id: `missing-${String(index).padStart(2, "0")}` }))
      f.state().acknowledge(
        101,
        "github",
        event.id,
        eventFingerprint(event),
        true,
        false,
        Date.now(),
      )
    }
    await f.worker.poll()
    expect(f.readIncident).toHaveBeenCalledTimes(12)
    expect(f.readIncident.mock.calls.some(([, id]) => id === "missing-12")).toBe(false)
    f.readIncident.mockClear()
    await f.worker.poll()
    expect(f.readIncident).toHaveBeenCalledTimes(12)
    expect(f.readIncident.mock.calls[0]?.[1]).toBe("missing-12")
    expect(f.send).not.toHaveBeenCalled()
    expect(f.state().active("github")).toHaveLength(13)
  })
})

describe("service status authorization and lifecycle", () => {
  it("rejects overlapping polls without another read and permits polling after completion", async () => {
    const f = fixture()
    const response = deferred<StatusSummary>()
    f.readSummary.mockReturnValueOnce(response.promise)
    const polling = f.worker.poll()
    await expect(f.worker.poll()).rejects.toThrow("already active")
    expect(f.readSummary).toHaveBeenCalledOnce()
    response.resolve(summary("github"))
    await expect(polling).resolves.toBe(90)
    await f.worker.poll()
    expect(f.readSummary).toHaveBeenCalledTimes(2)
  })

  it("does not send or acknowledge a response read under a replaced applied revision", async () => {
    const f = fixture()
    const response = deferred<StatusSummary>()
    f.readSummary.mockReturnValueOnce(response.promise)
    const polling = f.worker.poll()
    const rejected = expect(polling).rejects.toThrow("settings changed")
    f.configure({ chatIds: [-303] })
    response.resolve(summary("github", { incidents: [incident()] }))
    await rejected
    expect(f.send).not.toHaveBeenCalled()
    expect(f.readIncident).not.toHaveBeenCalled()
    expect(f.state().active("github")).toEqual([])
    await f.worker.poll()
    expect(f.send.mock.calls.map(([chatId]) => chatId)).toEqual([-303])
  })

  it("stops subsequent sends and does not acknowledge an in-flight send after configuration changes", async () => {
    const f = fixture({ chatIds: [101, -202] })
    const sending = deferred<void>()
    const response = deferred<void>()
    f.send.mockImplementationOnce(async () => {
      sending.resolve()
      await response.promise
    })
    const polling = f.worker.poll()
    const rejected = expect(polling).rejects.toThrow("settings changed")
    await sending.promise
    f.configure({ enabled: false })
    response.resolve()
    await rejected
    expect(f.send).toHaveBeenCalledOnce()
    expect(f.state().active("github")).toEqual([])
    f.configure({ enabled: true })
    await f.worker.poll()
    expect(f.send.mock.calls.map(([chatId]) => chatId)).toEqual([101, 101, -202])
  })

  it("stops a later recovery-read batch immediately after an applied revision changes", async () => {
    const f = fixture()
    f.summaries.set("github", summary("github"))
    for (let index = 0; index < 5; index++) {
      const event = incidentEvent(incident({ id: `missing-${index}` }))
      f.state().acknowledge(
        101,
        "github",
        event.id,
        eventFingerprint(event),
        true,
        false,
        Date.now(),
      )
    }
    const reading = deferred<void>()
    const response = deferred<void>()
    f.readIncident.mockImplementation(async (_provider, id) => {
      if (f.readIncident.mock.calls.length === 4) reading.resolve()
      await response.promise
      return incident({ id })
    })
    const polling = f.worker.poll()
    const rejected = expect(polling).rejects.toThrow("settings changed")
    await reading.promise
    f.configure({ enabled: false })
    response.resolve()
    await rejected
    expect(f.readIncident).toHaveBeenCalledTimes(4)
    expect(f.send).not.toHaveBeenCalled()
  })

  it.each(["summary", "detail", "send"] as const)(
    "aborts an active %s on close, retains checkpoints, and makes close idempotent",
    async (operation) => {
      vi.useFakeTimers()
      const f = fixture({ chatIds: [101, -202] })
      const started = deferred<void>()
      let activeSignal: AbortSignal | undefined
      if (operation === "summary") {
        f.readSummary.mockImplementation(async (_provider, options) => {
          activeSignal = options?.signal
          started.resolve()
          return untilAborted<StatusSummary>(activeSignal)
        })
      }
      if (operation === "detail") {
        f.summaries.set("github", summary("github"))
        const event = incidentEvent(incident())
        f.state().acknowledge(
          101,
          "github",
          event.id,
          eventFingerprint(event),
          true,
          false,
          Date.now(),
        )
        f.readIncident.mockImplementation(async (_provider, _id, options) => {
          activeSignal = options?.signal
          started.resolve()
          return untilAborted<StatusIncident>(activeSignal)
        })
      }
      if (operation === "send") {
        f.send.mockImplementation(async (_chatId, _text, signal) => {
          activeSignal = signal
          started.resolve()
          return untilAborted<void>(signal)
        })
      }
      const polling = f.worker.poll()
      const rejected = expect(polling).rejects.toMatchObject({ name: "AbortError" })
      await started.promise
      const closing = f.worker.close()
      expect(f.worker.close()).toBe(closing)
      await closing
      await rejected
      expect(activeSignal?.aborted).toBe(true)
      expect(f.send).toHaveBeenCalledTimes(operation === "send" ? 1 : 0)
      expect(f.state().get(-202, "github", "incident:api-errors")).toBeUndefined()
      expect(f.state().active("github")).toHaveLength(operation === "detail" ? 1 : 0)
      expect(vi.getTimerCount()).toBe(0)
      await expect(f.worker.poll()).rejects.toMatchObject({ name: "AbortError" })
    },
  )

  it.each(["summary", "send"] as const)(
    "aborts an in-flight %s when pending settings are detected by the guard",
    async (operation) => {
      vi.useFakeTimers()
      const f = fixture({ chatIds: [101, -202] })
      const started = deferred<void>()
      let activeSignal: AbortSignal | undefined
      if (operation === "summary") {
        f.readSummary.mockImplementation(async (_provider, options) => {
          activeSignal = options?.signal
          started.resolve()
          return untilAborted<StatusSummary>(activeSignal)
        })
      } else {
        f.send.mockImplementation(async (_chatId, _text, signal) => {
          activeSignal = signal
          started.resolve()
          return untilAborted<void>(signal)
        })
      }
      const polling = f.worker.poll()
      const rejected = expect(polling).rejects.toMatchObject({ name: "AbortError" })
      await started.promise
      f.configure({ enabled: false }, false)
      await vi.advanceTimersByTimeAsync(999)
      expect(activeSignal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await rejected
      expect(activeSignal?.aborted).toBe(true)
      expect(f.state().active("github")).toEqual([])
      expect(f.send).toHaveBeenCalledTimes(operation === "send" ? 1 : 0)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it("spaces attempts by 100ms across targets and providers, including failed attempts", async () => {
    const f = fixture({ providers: ["github", "openai"], chatIds: [101, -202] })
    f.summaries.set("openai", summary("openai", { incidents: [incident()] }))
    const times: number[] = []
    f.send.mockImplementation(async () => {
      times.push(Date.now())
      if (times.length === 1) throw new Error("Telegram unavailable")
    })
    await f.worker.poll()
    expect(f.send.mock.calls.map(([chatId]) => chatId)).toEqual([101, -202, 101, -202])
    for (let index = 1; index < times.length; index++) {
      expect((times[index] ?? 0) - (times[index - 1] ?? 0)).toBeGreaterThanOrEqual(100)
    }
    expect(f.state().get(101, "github", "incident:api-errors")).toBeUndefined()
  })

  it("waits again when a timer returns before the send interval has elapsed", async () => {
    const f = fixture({ chatIds: [101, -202] })
    let clock = 1_000_000
    vi.spyOn(Date, "now").mockImplementation(() => clock)
    const waits: number[] = []
    const times: number[] = []
    f.send.mockImplementation(async () => {
      times.push(Date.now())
    })
    await vi.mocked(delay).withImplementation(
      async (milliseconds, value) => {
        waits.push(milliseconds ?? 1)
        clock += waits.length === 1 ? 99 : 1
        return value
      },
      async () => {
        await f.worker.poll()
        expect(waits).toEqual([100, 1])
        expect(times).toEqual([1_000_000, 1_000_100])
      },
    )
  })

  it("bounds each send to five seconds and leaves a timed-out delivery retryable", async () => {
    vi.useFakeTimers()
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController()
      setTimeout(
        () => controller.abort(new DOMException("Send timed out", "TimeoutError")),
        milliseconds,
      )
      return controller.signal
    })
    const f = fixture()
    f.send.mockImplementationOnce(async (_chatId, _text, signal) => untilAborted<void>(signal))
    const polling = f.worker.poll()
    await vi.advanceTimersByTimeAsync(4999)
    expect(f.logger.warn).not.toHaveBeenCalled()
    expect(f.state().active("github")).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await expect(polling).resolves.toBe(90)
    expect(timeout).toHaveBeenCalledExactlyOnceWith(5000)
    expect(f.logger.warn).toHaveBeenCalledOnce()
    expect(f.state().active("github")).toEqual([])
    await f.worker.poll()
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(f.state().get(101, "github", "incident:api-errors")?.active).toBe(1)
  })
})
