import type { UserFromGetMe } from "grammy/types"
import { afterEach, expect, it, vi } from "vitest"
import type { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { loadSettings } from "../src/config/settings.js"
import { createTelegramAgentBot } from "../src/telegram/bot.js"
import { runTelegramPolling } from "../src/telegram/polling.js"
import { approvedStore } from "./helpers/admin-store.js"

vi.mock("../src/telegram/polling.js", () => ({ runTelegramPolling: vi.fn() }))
afterEach(() => vi.restoreAllMocks())

function setup(failNotifications = false) {
  const events: string[] = []
  const stop = vi.fn(async () => {
    events.push("polling stopped")
  })
  vi.mocked(runTelegramPolling).mockImplementation(() => {
    events.push("polling started")
    return { task: async () => {}, stop } as unknown as ReturnType<typeof runTelegramPolling>
  })
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const telegram = createTelegramAgentBot(
    loadSettings({ BOT_ADMIN_ID: "7", BOT_TOKEN: "fixture" }),
    {} as ChatSessionRegistry,
    logger,
    {
      control: approvedStore([]),
      botInfo: {
        id: 99,
        is_bot: true,
        first_name: "Sumire",
        username: "sumire_bot",
      } as UserFromGetMe,
    },
  )
  const messages: Array<{ chat_id: number; text: string }> = []
  telegram.bot.api.config.use(async (_previous, method, payload, signal) => {
    if (method === "sendMessage") {
      const message = payload as { chat_id: number; text: string }
      messages.push(message)
      events.push(message.text)
      expect(signal).toBeInstanceOf(AbortSignal)
      if (failNotifications) throw new Error("Telegram unavailable")
    }
    return { ok: true, result: true } as never
  })
  return { telegram, messages, events, stop, logger }
}

it("notifies only the configured admin after startup and before stopping polling", async () => {
  const { telegram, messages, events, stop } = setup()
  await telegram.start()
  await Promise.all([telegram.stop(), telegram.stop()])
  await telegram.stop()
  expect(messages).toEqual([
    { chat_id: 7, text: "Sumire bot 已啟動。" },
    { chat_id: 7, text: "Sumire bot 即將關閉。" },
  ])
  expect(events).toEqual([
    "polling started",
    "Sumire bot 已啟動。",
    "Sumire bot 即將關閉。",
    "polling stopped",
  ])
  expect(stop).toHaveBeenCalledOnce()
})

it("logs notification failures without blocking startup or shutdown", async () => {
  const { telegram, messages, stop, logger } = setup(true)
  await expect(telegram.start()).resolves.toBeUndefined()
  await expect(telegram.stop()).resolves.toBeUndefined()
  expect(messages).toHaveLength(2)
  expect(logger.warn).toHaveBeenCalledTimes(2)
  expect(stop).toHaveBeenCalledOnce()
})

it("bounds lifecycle notifications to five seconds", async () => {
  vi.useFakeTimers()
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error("Notification timed out")), milliseconds)
    return controller.signal
  })
  const { telegram, stop, logger } = setup()
  telegram.bot.api.config.use(async (previous, method, payload, signal) => {
    if (method !== "sendMessage") return previous(method, payload, signal)
    await new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("Request aborted")), { once: true })
    })
    throw new Error("Unreachable")
  })
  try {
    const starting = telegram.start()
    await vi.advanceTimersByTimeAsync(5_000)
    await starting
    const stopping = telegram.stop()
    await vi.advanceTimersByTimeAsync(5_000)
    await stopping
    expect(timeout.mock.calls).toEqual([[5_000], [5_000]])
    expect(logger.warn).toHaveBeenCalledTimes(2)
    expect(stop).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})

it("does not send lifecycle notifications when stopped before startup", async () => {
  const { telegram, messages, stop } = setup()
  await telegram.stop()
  await telegram.start()
  expect(messages).toEqual([])
  expect(stop).not.toHaveBeenCalled()
})

it("does not announce startup if initialization fails", async () => {
  const { telegram, messages, stop } = setup()
  vi.spyOn(telegram.bot, "init").mockRejectedValueOnce(new Error("Invalid token"))
  await expect(telegram.start()).rejects.toThrow("Invalid token")
  await telegram.stop()
  expect(messages).toEqual([])
  expect(stop).not.toHaveBeenCalled()
})
