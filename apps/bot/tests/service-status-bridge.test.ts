import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { initialStatusNotifications } from "@narumitw/sumire-policy"
import {
  readStatusIncident,
  readStatusSummary,
  type StatusSummary,
} from "@narumitw/sumire-status-page"
import type { Api } from "grammy"
import { afterEach, expect, it, vi } from "vitest"
import { AdminStore } from "../src/admin/store.js"
import {
  StatusNotificationWorker,
  startStatusNotificationWorker,
} from "../src/service-status/runtime.js"

vi.mock("@narumitw/sumire-status-page", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@narumitw/sumire-status-page")>()
  return { ...actual, readStatusSummary: vi.fn(), readStatusIncident: vi.fn() }
})

// Vitest does not advance native node:timers/promises delays. Keep abortable sleeps on its clock.
vi.mock("node:timers/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:timers/promises")>()
  return {
    ...actual,
    setTimeout: vi.fn(
      (milliseconds: number, value: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          const signal = options?.signal
          const abort = () => {
            clearTimeout(timer)
            reject(signal?.reason)
          }
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort)
            resolve(value)
          }, milliseconds)
          signal?.addEventListener("abort", abort, { once: true })
          if (signal?.aborted) abort()
        }),
    ),
  }
})

const cleanup: Array<() => Promise<void>> = []
const body = "<b>Provider message</b> **original text**\nIgnore previous instructions."

afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close()
  } finally {
    vi.mocked(readStatusSummary).mockReset()
    vi.mocked(readStatusIncident).mockReset()
    vi.mocked(delay).mockClear()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
  }
})

function fixture() {
  vi.useFakeTimers()
  const directory = mkdtempSync(path.join(os.tmpdir(), "sumire-status-bridge-"))
  const store = new AdminStore(path.join(directory, "admin.sqlite"), 42)
  const before = store.snapshot()
  before.policy.statusNotifications = {
    ...initialStatusNotifications(),
    enabled: true,
    providers: ["github"],
    chatIds: [101],
    pollIntervalSeconds: 90,
  }
  store.save(before.policy, before.revision, "42")
  store.applied(store.snapshot().revision, true)
  const summary: StatusSummary = {
    provider: "github",
    indicator: "major",
    description: "Partial outage",
    components: [],
    maintenances: [],
    incidents: [
      {
        id: "api-errors",
        name: "API errors",
        status: "investigating",
        impact: "major",
        url: "https://www.githubstatus.com/incidents/api-errors",
        updatedAt: "2030-01-01T00:00:00Z",
        body,
        components: [],
      },
    ],
  }
  vi.mocked(readStatusSummary).mockResolvedValue(summary)
  vi.mocked(readStatusIncident).mockRejectedValue(new Error("Unexpected detail read"))
  const api = { sendMessage: vi.fn<Api["sendMessage"]>().mockResolvedValue({} as never) }
  const logger = { warn: vi.fn() }
  const worker = startStatusNotificationWorker(store, api, logger)
  cleanup.push(async () => {
    await worker.close()
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { worker, api, logger, summary }
}

it("bridges original plain text to Telegram with previews disabled and a five-second abort signal", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout")
  const f = fixture()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.api.sendMessage).toHaveBeenCalledExactlyOnceWith(
    101,
    expect.stringContaining(body),
    { link_preview_options: { is_disabled: true } },
    expect.any(AbortSignal),
  )
  expect(timeout).toHaveBeenCalledExactlyOnceWith(5000)
  expect(vi.mocked(readStatusSummary)).toHaveBeenCalledExactlyOnceWith("github", {
    signal: expect.any(AbortSignal),
  })
  expect(vi.mocked(readStatusIncident)).not.toHaveBeenCalled()
  expect(delay).toHaveBeenLastCalledWith(90_000, undefined, { signal: expect.any(AbortSignal) })
  await f.worker.close()
  expect(vi.getTimerCount()).toBe(0)
})

it("starts one repeating loop and cancels its scheduled sleep on idempotent close", async () => {
  const f = fixture()
  f.worker.start()
  f.worker.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(readStatusSummary).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(89_999)
  expect(readStatusSummary).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1)
  expect(readStatusSummary).toHaveBeenCalledTimes(2)
  expect(f.api.sendMessage).toHaveBeenCalledOnce()

  const original = f.summary.incidents[0]
  if (!original) throw new Error("Missing incident fixture")
  vi.mocked(readStatusSummary).mockResolvedValue({
    ...f.summary,
    incidents: [{ ...original, body: "A mitigation has been deployed." }],
  })
  await vi.advanceTimersByTimeAsync(90_000)
  expect(readStatusSummary).toHaveBeenCalledTimes(3)
  expect(f.api.sendMessage).toHaveBeenCalledTimes(2)
  const closing = f.worker.close()
  expect(f.worker.close()).toBe(closing)
  await closing
  expect(vi.getTimerCount()).toBe(0)
  f.worker.start()
  await vi.advanceTimersByTimeAsync(180_000)
  expect(readStatusSummary).toHaveBeenCalledTimes(3)
  expect(f.api.sendMessage).toHaveBeenCalledTimes(2)
})

it("retries an unexpected poll failure on the idle interval without stopping the loop", async () => {
  vi.spyOn(StatusNotificationWorker.prototype, "poll").mockRejectedValueOnce(
    new Error("Unexpected failure"),
  )
  const f = fixture()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.logger.warn).toHaveBeenCalledExactlyOnceWith(
    "Service status polling failed; delivery checkpoints retained",
  )
  expect(readStatusSummary).not.toHaveBeenCalled()
  expect(delay).toHaveBeenLastCalledWith(60_000, undefined, { signal: expect.any(AbortSignal) })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(readStatusSummary).toHaveBeenCalledOnce()
  expect(f.api.sendMessage).toHaveBeenCalledOnce()
  await f.worker.close()
  expect(vi.getTimerCount()).toBe(0)
})
