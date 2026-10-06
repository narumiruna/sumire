import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import type { UserFromGetMe } from "grammy/types"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { DurableSession } from "../src/agent/durable-session.js"
import { OutboxDoc } from "../src/agent/durable-state.js"
import { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { loadSettings } from "../src/config/settings.js"
import type { Logger } from "../src/logging.js"
import { createTelegramAgentBot } from "../src/telegram/bot.js"
import { runTelegramPolling } from "../src/telegram/polling.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

vi.mock("../src/telegram/polling.js", () => ({
  runTelegramPolling: vi.fn(() => ({ task: async () => {}, stop: async () => {} })),
}))

afterEach(() => vi.clearAllMocks())

const botInfo: UserFromGetMe = {
  id: 99,
  is_bot: true,
  first_name: "Sumire",
  username: "sumire_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
}
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

describe("Telegram durable recovery delivery", () => {
  it.each(["discovery", "recovery"] as const)(
    "does not start polling after shutdown during %s",
    async (phase) => {
      let release = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const interrupted = vi.fn(async () => {
        await gate
      })
      const recover = vi.fn(async () => {
        if (phase === "recovery") await interrupted()
      })
      const telegram = createTelegramAgentBot(
        loadSettings({ BOT_TOKEN: "test-token" }),
        { recover } as unknown as ChatSessionRegistry,
        logger,
        {
          botInfo,
          recoverChats: async () => {
            if (phase === "discovery") await interrupted()
            return [7]
          },
        },
      )
      telegram.bot.api.config.use(async () => ({ ok: true, result: true }) as never)
      const starting = telegram.start()
      try {
        await vi.waitFor(() => expect(interrupted).toHaveBeenCalledOnce())
        await telegram.stop()
        release()
        await starting
        expect(runTelegramPolling).not.toHaveBeenCalled()
      } finally {
        release()
        await starting
        await telegram.stop()
      }
    },
  )

  it.each([false, true])(
    "acknowledges an empty-answer fallback only after successful delivery (failure=%s)",
    async (failDelivery) => {
      const fixture = await createPiFixture()
      let session: DurableSession | undefined
      const sessions = new ChatSessionRegistry(
        async () => {
          session = await fixture.createSession()
          return session
        },
        fixture.settings.botSessionLogDir,
        logger,
      )
      const recordDelivery = vi.spyOn(sessions, "recordDelivery")
      const telegram = createTelegramAgentBot(
        { ...fixture.settings, botToken: "test-token" },
        sessions,
        logger,
        { botInfo },
      )
      const texts: unknown[] = []
      telegram.bot.api.config.use(async (_previous, _method, payload) => {
        texts.push((payload as { text?: string }).text)
        if (failDelivery && texts.length > 1)
          return { ok: false, error_code: 500, description: "Offline delivery failure" } as never
        return {
          ok: true,
          result: { message_id: 100, date: 0, chat: { id: 123, type: "private" } },
        } as never
      })
      fixture.enqueueAnswer("")
      try {
        const handling = telegram.bot.handleUpdate({
          update_id: 1,
          message: {
            message_id: 1,
            date: 0,
            chat: { id: 123, type: "private", first_name: "Offline" },
            from: { id: 123, is_bot: false, first_name: "Offline" },
            text: "question",
          },
        })
        if (failDelivery) await expect(handling).rejects.toThrow("Offline delivery failure")
        else await handling
        if (!session) throw new Error("Missing session")
        expect(texts).toContain("模型沒有回覆內容，請稍後再試。")
        const pending = (await session.harness.snapshot(OutboxDoc, context))?.pending
        expect(pending).toHaveLength(failDelivery ? 1 : 0)
        if (failDelivery) expect(recordDelivery).not.toHaveBeenCalled()
        else expect(recordDelivery).toHaveBeenCalledOnce()
      } finally {
        await telegram.stop()
        await sessions.dispose()
        await fixture.cleanup()
      }
    },
  )

  it.each(["default", "publish"] as const)(
    "recovers a saved status using the %s delivery contract",
    async (mode) => {
      const checkpoint = {
        sessionId: "durable-session",
        entryId: "1:2",
        generation: 0,
        requestId: "request",
      }
      const recordDelivery = vi.fn(async () => {})
      let handled = false
      const recover: ChatSessionRegistry["recover"] = async (chats, deliver) => {
        expect(chats).toEqual([7])
        handled = await deliver(
          7,
          { text: "Recovered answer", entryId: "1:2", requestId: "request" },
          { sourceMessageId: 10, statusMessageId: 11, mode },
          checkpoint,
          () => true,
        )
      }
      const sessions = { recover, recordDelivery } as unknown as ChatSessionRegistry
      const publish = vi.fn(async () => `https://morsel.test/s/${"a".repeat(43)}`)
      const telegram = createTelegramAgentBot(
        loadSettings({ BOT_TOKEN: "test-token", BOT_WHITELIST: "7" }),
        sessions,
        logger,
        {
          botInfo,
          recoverChats: async () => [7],
          morselPublisher: { isConfigured: true, publish },
        },
      )
      const calls: { method: string; payload: Record<string, unknown> }[] = []
      telegram.bot.api.config.use(async (_previous, method, payload) => {
        calls.push({ method, payload })
        return {
          ok: true,
          result: { message_id: 11, date: 0, chat: { id: 7, type: "private" } },
        } as never
      })
      try {
        await telegram.start()
        expect(handled).toBe(true)
        expect(calls.map((call) => call.method)).toEqual(["setMyCommands", "editMessageText"])
        expect(calls[1]?.payload).toMatchObject({ chat_id: 7, message_id: 11 })
        if (mode === "publish") {
          expect(publish).toHaveBeenCalledWith("Recovered answer")
          expect(calls[1]?.payload.text).toContain("https://morsel.test/s/")
        } else {
          expect(publish).not.toHaveBeenCalled()
          expect(calls[1]?.payload.text).toBe("Recovered answer")
        }
        expect(recordDelivery).toHaveBeenCalledWith(7, checkpoint, [11])
      } finally {
        await telegram.stop()
      }
    },
  )

  it("does not send or acknowledge a stale recovered response", async () => {
    const recordDelivery = vi.fn()
    const recover: ChatSessionRegistry["recover"] = async (_chats, deliver) => {
      expect(
        await deliver(
          7,
          { text: "Stale answer" },
          { sourceMessageId: 10, mode: "default" },
          undefined,
          () => false,
        ),
      ).toBe(false)
    }
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      { recover, recordDelivery } as unknown as ChatSessionRegistry,
      logger,
      { botInfo, recoverChats: async () => [7] },
    )
    const api = vi.fn(async (..._args: unknown[]) => ({ ok: true, result: true }))
    telegram.bot.api.config.use(api as never)
    try {
      await telegram.start()
      expect(api).toHaveBeenCalledOnce()
      expect(api.mock.calls[0]?.[1]).toBe("setMyCommands")
      expect(recordDelivery).not.toHaveBeenCalled()
    } finally {
      await telegram.stop()
    }
  })
})
