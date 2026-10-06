import type { UserFromGetMe } from "grammy/types"
import { describe, expect, it, vi } from "vitest"

import type { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { loadSettings } from "../src/config/settings.js"
import type { Logger } from "../src/logging.js"
import { createTelegramAgentBot } from "../src/telegram/bot.js"

vi.mock("../src/telegram/polling.js", () => ({
  runTelegramPolling: () => ({ task: async () => {}, stop: async () => {} }),
}))

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
