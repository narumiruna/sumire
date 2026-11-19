import { randomUUID } from "node:crypto"
import type { ScheduleInput } from "@narumitw/sumire-contracts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AdminError, AdminStore } from "../src/admin/store.js"
import type { Logger } from "../src/logging.js"
import { scheduleInput, scheduleTaskLimit } from "../src/schedules/schema.js"
import { nextScheduleTime, ScheduleStore } from "../src/schedules/store.js"
import { ScheduleWorker } from "../src/schedules/worker.js"
import { approvedStore, closeTestStores } from "./helpers/admin-store.js"

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value")
  return value
}

const now = Date.UTC(2026, 10, 20, 0)
let control: ReturnType<typeof approvedStore>
let schedules: ScheduleStore
const input = (overrides: Partial<ScheduleInput> = {}): ScheduleInput => ({
  chatId: 42,
  task: "Summarize fixture news",
  runAt: now + 60_000,
  timeZone: "Asia/Taipei",
  repeatMinutes: null,
  ...overrides,
})
beforeEach(() => {
  control = approvedStore([42, -100])
  control.observe(42, "private", "Fixture chat")
  control.observe(-100, "supergroup", "Fixture group")
  schedules = new ScheduleStore(control)
})
afterEach(() => {
  closeTestStores()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("persisted schedules", () => {
  it("creates, pauses, resumes and deletes with optimistic revisions and content-free audit", () => {
    const policy = control.snapshot()
    const first = schedules.create(input({ task: "  fixture-private-user-message  " }), "7", now)
    expect(first).toMatchObject({
      revision: 1,
      state: "active",
      task: "fixture-private-user-message",
      nextRunAt: now + 60_000,
      lastOutcome: null,
    })
    expect(new ScheduleStore(control).list().items).toEqual([first])
    const paused = schedules.change(first.id, 1, "pause", "7", now)
    expect(paused.state).toBe("paused")
    expect(() => schedules.change(first.id, 1, "resume", "7", now)).toThrow("changed")
    expect(schedules.claim(now + 120_000)).toBeUndefined()
    const resumed = schedules.change(first.id, paused.revision, "resume", "7", now + 120_000)
    expect(resumed.nextRunAt).toBe(first.runAt)
    expect(() => schedules.delete(first.id, paused.revision, "7")).toThrow("changed")
    schedules.delete(first.id, resumed.revision, "7")
    expect(schedules.list().items).toEqual([])
    expect(() => schedules.delete(first.id, resumed.revision, "7")).toThrow("not found")
    expect(JSON.stringify(control.listAudit(0))).not.toContain("fixture-private-user-message")
    expect(control.snapshot()).toEqual(policy)
  })
  it("deduplicates a retried creation even after its execution time and rejects changed payloads", () => {
    const id = randomUUID()
    const first = schedules.create(input(), "7", now, id)
    expect(schedules.create(input(), "7", now + 120_000, id)).toEqual(first)
    expect(schedules.list().items).toHaveLength(1)
    expect(() => schedules.create(input({ task: "different" }), "7", now, id)).toThrow(
      "request changed",
    )
    expect(() => schedules.create(input(), "other", now, id)).toThrow("request changed")
    expect(
      control.listAudit(0).filter((entry) => entry.operation === "schedule.create"),
    ).toHaveLength(1)
  })
  it.each([
    { task: " " },
    { task: "x".repeat(scheduleTaskLimit + 1) },
    { timeZone: "Mars/Olympus" },
    { chatId: 0 },
    { chatId: Number.MAX_SAFE_INTEGER + 1 },
    { repeatMinutes: 5 },
    { runAt: NaN },
  ])("rejects invalid structured input %j", (overrides) => {
    expect(scheduleInput.safeParse({ ...input(), ...overrides }).success).toBe(false)
  })
  it("validates future execution, known targets and current applied access", () => {
    expect(() => schedules.create(input({ runAt: now }), "7", now)).toThrow("future")
    expect(() => schedules.create(input({ chatId: 999 }), "7", now)).toThrow(AdminError)
    control.db.prepare("DELETE FROM chats WHERE id=42").run()
    expect(() => schedules.create(input(), "7", now)).toThrow("known")
    control.observe(42)
    control.db.prepare("UPDATE settings SET status='pending'").run()
    expect(() => schedules.create(input(), "7", now)).toThrow("policy")
    expect(schedules.list().items).toEqual([])
  })
  it("bounds saved tasks and rolls back a mutation if audit storage fails", () => {
    const audit = vi.spyOn(control, "audit").mockImplementation(() => {
      throw new Error("fixture-write-failure")
    })
    expect(() => schedules.create(input(), "7", now)).toThrow("fixture-write-failure")
    expect(schedules.list().items).toEqual([])
    audit.mockRestore()
    for (let i = 0; i < 100; i++) schedules.create(input(), "7", now)
    expect(schedules.list().items).toHaveLength(100)
    expect(() => schedules.create(input(), "7", now)).toThrow("limit reached")
  })
  it("claims a due occurrence once, completes single-use work and rejects stale receipts", () => {
    const first = schedules.create(input(), "7", now)
    expect(schedules.claim(now)).toBeUndefined()
    const run = required(schedules.claim(now + 60_000))
    expect(run?.schedule.lastOutcome).toBe("running")
    expect(schedules.claim(now + 60_001)).toBeUndefined()
    expect(() => schedules.change(first.id, 1, "pause", "7", now)).toThrow("changed")
    schedules.finish({ ...run, runId: "stale" }, true, now + 61_000)
    expect(schedules.list().items[0]?.lastOutcome).toBe("running")
    schedules.finish(run, true, now + 62_000)
    expect(schedules.list().items[0]).toMatchObject({
      state: "completed",
      lastOutcome: "succeeded",
      nextRunAt: null,
    })
    expect(schedules.claim(now + 3600_000)).toBeUndefined()
    expect(() => schedules.change(first.id, 3, "resume", "7", now)).toThrow("cannot perform")
  })
  it("skips missed intervals and keeps cadence anchored to the first execution", () => {
    const first = schedules.create(input({ repeatMinutes: 60 }), "7", now)
    const run = required(schedules.claim(now + 5 * 3600_000))
    schedules.finish(run, true, now + 5 * 3600_000 + 30_000)
    const updated = required(schedules.list().items[0])
    expect(updated.nextRunAt).toBe(first.runAt + 5 * 3600_000)
    expect(schedules.claim(now + 5 * 3600_000 + 30_001)).toBeUndefined()
    const paused = schedules.change(first.id, updated.revision, "pause", "7", now)
    const resumed = schedules.change(first.id, paused.revision, "resume", "7", now + 24 * 3600_000)
    expect(resumed.nextRunAt).toBe(first.runAt + 24 * 3600_000)
  })
  it("never reclaims an occurrence after the clock moves backward during a repeat", () => {
    const hour = 3600_000
    const first = schedules.create(input({ repeatMinutes: 60 }), "7", now)
    schedules.finish(required(schedules.claim(first.runAt)), true, first.runAt)
    const claimedAt = first.runAt + hour
    const run = required(schedules.claim(claimedAt))
    const earlier = claimedAt - 1000

    schedules.finish(run, true, earlier)
    const finished = required(schedules.list().items[0])
    expect(finished.nextRunAt).toBe(claimedAt + hour)
    const paused = schedules.change(finished.id, finished.revision, "pause", "7", earlier)
    const resumed = schedules.change(paused.id, paused.revision, "resume", "7", earlier)
    expect(resumed.nextRunAt).toBe(claimedAt + hour)
    expect(schedules.claim(claimedAt)).toBeUndefined()
    expect(schedules.claim(claimedAt + hour)?.schedule.nextRunAt).toBe(claimedAt + hour)
  })
  it("does not unpause a running recurrence or cancel admitted work on deletion", () => {
    schedules.create(input({ repeatMinutes: 60 }), "7", now)
    const run = required(schedules.claim(now + 60_000))
    const paused = schedules.change(run.schedule.id, run.schedule.revision, "pause", "7", now)
    expect(() => schedules.change(paused.id, paused.revision, "resume", "7", now)).toThrow(
      "current execution",
    )
    schedules.finish(run, true, now + 61_000)
    expect(schedules.list().items[0]?.state).toBe("paused")
    const updated = required(schedules.list().items[0])
    schedules.delete(updated.id, updated.revision, "7")
    expect(() => schedules.finish(run, true, now + 62_000)).not.toThrow()
    expect(schedules.list().items).toEqual([])
  })
  it("pauses failures and blocks rerunning a failed one-time attempt", () => {
    schedules.create(input(), "7", now)
    const run = required(schedules.claim(now + 60_000))
    schedules.finish(run, false, now + 61_000)
    const failed = required(schedules.list().items[0])
    expect(failed).toMatchObject({ state: "paused", lastOutcome: "failed", nextRunAt: null })
    expect(() => schedules.change(failed.id, failed.revision, "resume", "7", now)).toThrow(
      "previous execution",
    )
    expect(schedules.claim(now + 3600_000)).toBeUndefined()
  })
  it("marks abandoned attempts uncertain without replay, including repeating tasks", () => {
    schedules.create(input({ repeatMinutes: 60 }), "7", now)
    schedules.claim(now + 60_000)
    const reopened = new ScheduleStore(control)
    reopened.recoverInterrupted()
    const uncertain = required(reopened.list().items[0])
    expect(uncertain).toMatchObject({ state: "paused", lastOutcome: "interrupted" })
    expect(reopened.claim(now + 48 * 3600_000)).toBeUndefined()
    expect(() => reopened.change(uncertain.id, uncertain.revision, "resume", "7", now)).toThrow(
      "unknown",
    )
  })
  it("retains tasks and uncertain claims across a real SQLite close and reopen", () => {
    const task = schedules.create(input(), "7", now)
    schedules.claim(now + 60_000)
    const file = control.file
    control.close()
    const reopened = new AdminStore(file, 7)
    try {
      const persisted = new ScheduleStore(reopened)
      expect(persisted.list().items[0]).toMatchObject({ id: task.id, lastOutcome: "running" })
      persisted.recoverInterrupted()
      expect(persisted.list().items[0]).toMatchObject({
        id: task.id,
        state: "paused",
        lastOutcome: "interrupted",
      })
      expect(persisted.claim(now + 86400_000)).toBeUndefined()
    } finally {
      reopened.close()
    }
  })
  it("requires access again when resuming a previously authorized task", () => {
    const task = schedules.create(input(), "7", now)
    const paused = schedules.change(task.id, 1, "pause", "7", now)
    control.db.prepare("UPDATE settings SET status='pending'").run()
    expect(() => schedules.change(task.id, paused.revision, "resume", "7", now)).toThrow("policy")
  })
  it("uses elapsed-time recurrence across DST and skips an exact due boundary", () => {
    const anchor = Date.parse("2026-03-07T14:00:00Z")
    expect(nextScheduleTime(anchor, 1440, anchor)).toBe(anchor + 86400_000)
    expect(nextScheduleTime(anchor, 1440, anchor - 1)).toBe(anchor)
    expect(nextScheduleTime(anchor, 1440, anchor + 3 * 86400_000)).toBe(anchor + 4 * 86400_000)
  })
})

describe("bounded schedule dispatcher", () => {
  const logger = { warn: vi.fn() } as unknown as Logger
  let worker: ScheduleWorker | undefined
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
  })
  afterEach(() => {
    worker?.stop()
    worker = undefined
  })
  it("dispatches due tasks without overlap and preserves a pause made during execution", async () => {
    let release!: () => void
    const execute = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    schedules.create(input({ repeatMinutes: 60 }), "7", now)
    schedules.create(input(), "7", now)
    worker = new ScheduleWorker(schedules, execute, logger)
    worker.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(execute).toHaveBeenCalledTimes(1)
    const running = required(schedules.list().items.find((item) => item.lastOutcome === "running"))
    schedules.change(running.id, running.revision, "pause", "7", now)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(execute).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(1000)
    expect(execute).toHaveBeenCalledTimes(2)
    release()
    await vi.advanceTimersByTimeAsync(0)
  })
  it.each([true, false])(
    "retries a rolled-back completion without executing again (succeeded=%s)",
    async (succeeded) => {
      const first = schedules.create(input(), "7", now)
      const second = schedules.create(input({ runAt: first.runAt + 1000 }), "7", now)
      const execute = vi.fn(async () => {
        if (!succeeded) throw new Error("fixture-execution-failure")
      })
      const audit = control.audit.bind(control)
      const failCompletion = vi.spyOn(control, "audit").mockImplementation((...args) => {
        if (args[1] === "schedule.run" && args[3] !== "started")
          throw new Error("fixture-write-failure")
        return audit(...args)
      })
      const finish = vi.spyOn(schedules, "finish")
      worker = new ScheduleWorker(schedules, execute, logger)
      worker.start()

      await vi.advanceTimersByTimeAsync(62_000)
      expect(execute).toHaveBeenCalledOnce()
      expect(finish).toHaveBeenCalledTimes(3)
      const run = required(finish.mock.calls[0])[0]
      expect(run.schedule.id).toBe(first.id)
      expect(
        finish.mock.calls.every(([receipt, result]) => receipt === run && result === succeeded),
      ).toBe(true)
      expect(schedules.list().items.find((item) => item.id === first.id)?.lastOutcome).toBe(
        "running",
      )
      expect(schedules.list().items.find((item) => item.id === second.id)?.lastOutcome).toBeNull()

      failCompletion.mockRestore()
      await vi.advanceTimersByTimeAsync(1000)
      expect(execute).toHaveBeenCalledOnce()
      expect(schedules.list().items.find((item) => item.id === first.id)).toMatchObject({
        state: succeeded ? "completed" : "paused",
        lastOutcome: succeeded ? "succeeded" : "failed",
      })
      await vi.advanceTimersByTimeAsync(1000)
      expect(execute).toHaveBeenCalledTimes(2)
    },
  )
  it("rechecks revoked permissions before any model or Telegram call", async () => {
    schedules.create(input(), "7", now)
    const execute = vi.fn(async () => {})
    worker = new ScheduleWorker(schedules, execute, logger)
    worker.start()
    control.db.prepare("UPDATE settings SET status='pending'").run()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(execute).not.toHaveBeenCalled()
    expect(schedules.list().items[0]).toMatchObject({ state: "paused", lastOutcome: "failed" })
  })
  it("does not touch closed storage after stopping an admitted callback", async () => {
    let release!: () => void
    schedules.create(input(), "7", now)
    const execute = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    worker = new ScheduleWorker(schedules, execute, logger)
    worker.start()
    await vi.advanceTimersByTimeAsync(60_000)
    worker.stop()
    control.close()
    release()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
