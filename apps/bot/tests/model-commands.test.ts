import type { InlineKeyboardMarkup, Update, UserFromGetMe } from "grammy/types"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { loadSettings } from "../src/config/settings.js"
import { createTelegramAgentBot } from "../src/telegram/bot.js"
import { runTelegramPolling } from "../src/telegram/polling.js"
import { approvedStore } from "./helpers/admin-store.js"

vi.mock("../src/telegram/polling.js", () => ({
  runTelegramPolling: vi.fn(() => ({ task: async () => {}, stop: async () => {} })),
}))

const botInfo: UserFromGetMe = {
  id: 999,
  is_bot: true,
  first_name: "Test Bot",
  username: "test_bot",
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
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function command(text: string, userId = 7, groupId?: number): Update {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1_700_000_000,
      chat:
        groupId === undefined
          ? { id: userId, type: "private", first_name: "Alice" }
          : { id: groupId, type: "supergroup", title: "Group" },
      from: { id: userId, is_bot: false, first_name: "Alice" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]?.length ?? 0 }],
    },
  }
}

function callback(
  data: string,
  userId = 7,
  groupId?: number,
  snapshot: { messageId?: number; text?: string; replyMarkup?: InlineKeyboardMarkup } = {},
): Update {
  return {
    update_id: 2,
    callback_query: {
      id: "callback-id",
      from: { id: userId, is_bot: false, first_name: "Alice" },
      chat_instance: "test-chat",
      data,
      message: {
        message_id: snapshot.messageId ?? 100,
        date: 1_700_000_000,
        chat:
          groupId === undefined
            ? { id: userId, type: "private", first_name: "Alice" }
            : { id: groupId, type: "supergroup", title: "Group" },
        from: botInfo,
        text: snapshot.text ?? "Model picker",
        reply_markup: snapshot.replyMarkup,
      },
    },
  }
}

function setup() {
  const sessions = {
    submit: vi.fn(),
  }
  const telegram = createTelegramAgentBot(
    loadSettings({ BOT_ADMIN_ID: "7", BOT_TOKEN: "test-token" }),
    sessions as unknown as ChatSessionRegistry,
    logger,
    { control: approvedStore([7, -100]), botInfo },
  )
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  telegram.bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> })
    return { ok: true, result: true } as never
  })
  return { ...telegram, sessions, calls }
}

beforeEach(() => vi.clearAllMocks())

describe("Retired Telegram settings controls", () => {
  it.each(["model:page:1", "model:select:abcdefghijklmnopqrstuv", "thinking:select:high"])(
    "ignores stale callbacks: %s",
    async (data) => {
      const { bot, sessions, calls } = setup()
      await bot.handleUpdate(callback(data))
      expect(sessions.submit).not.toHaveBeenCalled()
      expect(calls).toHaveLength(0)
    },
  )

  it("does not advertise retired settings commands in help", async () => {
    const { bot, calls } = setup()
    await bot.handleUpdate(command("/help"))
    for (const removed of ["/model", "/provider", "/login", "/thinking"]) {
      expect(calls[0]?.payload.text).not.toContain(removed)
    }
    expect(calls[0]?.payload.text).toContain("/reset")
  })

  it("registers only supported commands before polling", async () => {
    const { start, stop, calls } = setup()
    await start()
    expect(calls[0]).toMatchObject({
      method: "setMyCommands",
      payload: {
        commands: expect.arrayContaining([
          { command: "help", description: expect.any(String) },
          { command: "reset", description: expect.any(String) },
        ]),
      },
    })
    for (const command of ["model", "provider", "login", "thinking"]) {
      expect(calls[0]?.payload.commands).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ command })]),
      )
    }
    expect(runTelegramPolling).toHaveBeenCalledOnce()
    await stop()
  })

  it("keeps polling if menu registration fails", async () => {
    const { bot, start, stop } = setup()
    vi.spyOn(bot.api, "setMyCommands").mockRejectedValueOnce(new Error("Telegram unavailable"))
    await start()
    expect(logger.warn).toHaveBeenCalledWith(
      "Could not register Telegram command menu",
      expect.any(Error),
    )
    expect(runTelegramPolling).toHaveBeenCalledOnce()
    await stop()
  })
})
