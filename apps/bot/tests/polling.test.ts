import type { RunnerHandle } from "@grammyjs/runner"
import { Bot, GrammyError, HttpError } from "grammy"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createLogger, type Logger } from "../src/logging.js"
import { runTelegramPolling } from "../src/telegram/polling.js"

const testToken = "123456:fake-test-token"
const networkError = new HttpError(
  "Network request for 'getUpdates' failed!",
  Object.assign(
    new Error(
      `request to https://api.telegram.org/bot${testToken}/getUpdates failed, reason: socket hang up`,
    ),
    { code: "ECONNRESET" },
  ),
)

let runners: RunnerHandle[] = []

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(async () => {
  const stopped = runners.map((runner) => runner.stop())
  await vi.advanceTimersByTimeAsync(5_000)
  await Promise.all(stopped)
  runners = []
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function setup(logger: Logger = createTestLogger()) {
  const bot = new Bot(testToken)
  vi.spyOn(bot, "init").mockResolvedValue(undefined)
  const handleUpdate = vi.spyOn(bot, "handleUpdate").mockResolvedValue(undefined)
  const getUpdates = vi.spyOn(bot.api, "getUpdates").mockImplementation(
    async (_args, signal) =>
      new Promise((_resolve, reject) => {
        const abort = () => reject(new Error("Polling aborted"))
        if (signal?.aborted) abort()
        else signal?.addEventListener("abort", abort, { once: true })
      }),
  )
  return {
    getUpdates,
    handleUpdate,
    logger,
    start() {
      const runner = runTelegramPolling(bot, logger)
      runners.push(runner)
      return runner
    },
  }
}

function createTestLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

describe("Telegram polling", () => {
  it("retries every five seconds without exponential stalls and limits warnings to once a minute", async () => {
    const { getUpdates, logger, start } = setup()
    getUpdates.mockRejectedValue(networkError)
    start()

    await vi.advanceTimersByTimeAsync(0)
    expect(getUpdates).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(getUpdates).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(getUpdates).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(55_000)
    expect(getUpdates).toHaveBeenCalledTimes(13)
    expect(logger.warn).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenLastCalledWith(
      "Telegram polling failed; retrying automatically",
      expect.objectContaining({ failures: 13 }),
    )
    expect(console.error).not.toHaveBeenCalled()
  })

  it("resumes update delivery, preserves offsets, and reports each new outage and recovery", async () => {
    const { getUpdates, handleUpdate, logger, start } = setup()
    getUpdates
      .mockRejectedValueOnce(networkError)
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce([{ update_id: 42 }])
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce([])
    start()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(handleUpdate).toHaveBeenCalledExactlyOnceWith({ update_id: 42 })
    expect(logger.info).toHaveBeenCalledExactlyOnceWith("Telegram polling recovered", {
      failures: 2,
    })
    expect(logger.warn).toHaveBeenCalledTimes(2)
    expect(getUpdates).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ offset: 43, allowed_updates: ["message"] }),
      expect.anything(),
    )

    await vi.advanceTimersByTimeAsync(5_000)
    expect(logger.info).toHaveBeenCalledTimes(2)
    expect(logger.info).toHaveBeenLastCalledWith("Telegram polling recovered", { failures: 1 })
    expect(handleUpdate).toHaveBeenCalledOnce()
  })

  it("honors Telegram retry_after before retrying rate-limited polling", async () => {
    const { getUpdates, start } = setup()
    getUpdates.mockRejectedValueOnce(
      new GrammyError(
        "Rate limited",
        {
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 12 },
        },
        "getUpdates",
        {},
      ),
    )
    start()

    await vi.advanceTimersByTimeAsync(16_999)
    expect(getUpdates).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(getUpdates).toHaveBeenCalledTimes(2)
  })

  it.each([401, 409])(
    "propagates fatal %s errors without retrying or raw console output",
    async (code) => {
      const { getUpdates, logger, start } = setup()
      const error = new GrammyError(
        "Polling failed",
        { ok: false, error_code: code, description: "Invalid polling configuration" },
        "getUpdates",
        {},
      )
      getUpdates.mockRejectedValue(error)
      const runner = start()
      const result = runner.task()?.catch((cause: unknown) => cause)

      await expect(result).resolves.toBe(error)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(getUpdates).toHaveBeenCalledOnce()
      expect(runner.isRunning()).toBe(false)
      expect(logger.warn).not.toHaveBeenCalled()
      expect(console.error).not.toHaveBeenCalled()
    },
  )

  it.each([false, true])(
    "stops without extra requests or warnings (retrying=%s)",
    async (retrying) => {
      const { getUpdates, logger, start } = setup()
      if (retrying) getUpdates.mockRejectedValue(networkError)
      const runner = start()
      await vi.advanceTimersByTimeAsync(0)

      const stopped = runner.stop()
      await vi.advanceTimersByTimeAsync(5_000)
      await stopped

      expect(getUpdates).toHaveBeenCalledOnce()
      expect(logger.warn).toHaveBeenCalledTimes(retrying ? 1 : 0)
      expect(logger.info).not.toHaveBeenCalled()
      expect(console.error).not.toHaveBeenCalled()
      expect(runner.isRunning()).toBe(false)
    },
  )

  it("routes transport warnings through token redaction without dumping stack traces", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const { getUpdates, start } = setup(createLogger())
    getUpdates.mockRejectedValueOnce(networkError)
    start()
    await vi.advanceTimersByTimeAsync(0)

    const output = stderr.mock.calls.flat().join(" ")
    expect(output).toContain("WARN | Telegram polling failed; retrying automatically")
    expect(output).toContain("/bot[redacted]/getUpdates")
    expect(output).toContain("socket hang up")
    expect(output).not.toContain(testToken)
    expect(output).not.toContain("    at ")
    expect(console.error).not.toHaveBeenCalled()
  })
})
