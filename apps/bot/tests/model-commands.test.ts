import type { OAuthLoginClient } from "@narumitw/sumire-login"
import type { InlineKeyboardMarkup, Update, UserFromGetMe } from "grammy/types"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { type ChatModelSettings, ModelSettingsError } from "../src/agent/model-settings.js"
import type { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { loadSettings } from "../src/config/settings.js"
import { createTelegramAgentBot } from "../src/telegram/bot.js"
import { runTelegramPolling } from "../src/telegram/polling.js"

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

function callback(data: string, userId = 7, groupId?: number): Update {
  return {
    update_id: 2,
    callback_query: {
      id: "callback-id",
      from: { id: userId, is_bot: false, first_name: "Alice" },
      chat_instance: "test-chat",
      data,
      message: {
        message_id: 100,
        date: 1_700_000_000,
        chat:
          groupId === undefined
            ? { id: userId, type: "private", first_name: "Alice" }
            : { id: groupId, type: "supergroup", title: "Group" },
        from: botInfo,
        text: "Model picker",
      },
    },
  }
}

function setup(options: { whitelist?: string; login?: OAuthLoginClient; models?: string[] } = {}) {
  const state: ChatModelSettings = {
    currentModel: "openai/reasoner",
    thinkingLevel: "off",
    thinkingLevels: ["off", "low", "medium", "high", "xhigh", "max"],
    models: options.models ?? ["openai/reasoner", "openai/plain"],
  }
  const sessions = {
    getModelSettings: vi.fn(async () => state),
    setModel: vi.fn(async (_chatId: number, model: string) => ({ ...state, currentModel: model })),
    setThinkingLevel: vi.fn(async (_chatId: number, level: string) => ({
      ...state,
      thinkingLevel: level as ChatModelSettings["thinkingLevel"],
    })),
    submit: vi.fn(),
  }
  const telegram = createTelegramAgentBot(
    loadSettings({ BOT_TOKEN: "test-token", BOT_WHITELIST: options.whitelist ?? "7" }),
    sessions as unknown as ChatSessionRegistry,
    logger,
    { botInfo, login: options.login },
  )
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  telegram.bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> })
    if (method === "sendMessage") {
      return {
        ok: true,
        result: {
          message_id: 100,
          date: 1_700_000_000,
          chat: { id: 7, type: "private", first_name: "Alice" },
          text: "Settings",
        },
      } as never
    }
    return { ok: true, result: true } as never
  })
  function buttons(index = 0) {
    const markup = calls[index]?.payload.reply_markup as InlineKeyboardMarkup | undefined
    if (!markup) throw new Error("Missing inline keyboard")
    return markup.inline_keyboard.flat()
  }
  return { ...telegram, state, sessions, calls, buttons }
}

beforeEach(() => vi.clearAllMocks())

describe("Telegram model and thinking commands", () => {
  it("shows model buttons and changes the chat through Pi without prompting", async () => {
    const { bot, sessions, calls, buttons } = setup()
    await bot.handleUpdate(command("/model@test_bot"))
    expect(calls[0]?.payload.text).toContain("Model：openai/reasoner")
    expect(buttons().map((button) => button.text)).toEqual(["✓ openai/reasoner", "openai/plain"])
    const selection = buttons()[1]
    if (!selection || !("callback_data" in selection)) throw new Error("Missing model selection")
    await bot.handleUpdate(callback(selection.callback_data))
    expect(sessions.setModel).toHaveBeenCalledExactlyOnceWith(7, "openai/plain")
    expect(calls[1]?.method).toBe("answerCallbackQuery")
    expect(calls[2]).toMatchObject({
      method: "editMessageText",
      payload: {
        text: expect.stringContaining("Model：openai/plain"),
        reply_markup: { inline_keyboard: [] },
      },
    })
    expect(sessions.submit).not.toHaveBeenCalled()
  })

  it("paginates bounded pickers and keeps callback data within 64 bytes for long model IDs", async () => {
    const models = Array.from({ length: 19 }, (_, i) => `provider/model-${i}-${"x".repeat(100)}`)
    const { bot, calls, buttons } = setup({ models })
    await bot.handleUpdate(command("/model"))
    expect(buttons()).toHaveLength(9)
    expect(calls[0]?.payload.text).toContain("1/3")
    for (const button of buttons()) {
      if (!("callback_data" in button)) throw new Error("Missing callback")
      expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64)
    }
    await bot.handleUpdate(callback("model:page:1"))
    expect(buttons(2)).toHaveLength(10)
    expect(calls[2]?.payload.text).toContain("2/3")
    await bot.handleUpdate(callback("model:page:999999"))
    expect(buttons(4)).toHaveLength(4)
    expect(calls[4]?.payload.text).toContain("3/3")
    expect(
      calls
        .filter((call) => call.method === "sendMessage" || call.method === "editMessageText")
        .every((call) => String(call.payload.text).length <= 1000),
    ).toBe(true)
  })

  it("supports direct model and thinking arguments without a picker or model turn", async () => {
    const { bot, sessions, calls } = setup()
    await bot.handleUpdate(command("/model openai/plain"))
    await bot.handleUpdate(command("/thinking high"))
    expect(sessions.setModel).toHaveBeenCalledExactlyOnceWith(7, "openai/plain")
    expect(sessions.setThinkingLevel).toHaveBeenCalledExactlyOnceWith(7, "high")
    expect(calls[1]?.payload.text).toContain("Thinking：high")
    expect(sessions.getModelSettings).not.toHaveBeenCalled()
    expect(sessions.submit).not.toHaveBeenCalled()
  })

  it("lists only supported thinking levels and accepts a thinking callback", async () => {
    const { bot, state, calls, sessions, buttons } = setup()
    state.thinkingLevel = "high"
    await bot.handleUpdate(command("/thinking"))
    expect(buttons().map((button) => button.text)).toEqual([
      "off",
      "low",
      "medium",
      "✓ high",
      "xhigh",
      "max",
    ])
    await bot.handleUpdate(callback("thinking:select:max"))
    expect(sessions.setThinkingLevel).toHaveBeenCalledExactlyOnceWith(7, "max")
    expect(calls[2]?.payload.text).toContain("Thinking：max")
    expect(sessions.submit).not.toHaveBeenCalled()
  })

  it("explains when a model has no thinking support", async () => {
    const { bot, state, calls, buttons } = setup()
    state.thinkingLevels = ["off"]
    await bot.handleUpdate(command("/thinking"))
    expect(buttons().map((button) => button.text)).toEqual(["✓ off"])
    expect(calls[0]?.payload.text).toContain("不支援 thinking")
  })

  it("rejects an unavailable stale model button", async () => {
    const { bot, sessions, state, calls, buttons } = setup()
    await bot.handleUpdate(command("/model"))
    const selection = buttons()[1]
    if (!selection || !("callback_data" in selection)) throw new Error("Missing model selection")
    state.models = ["openai/reasoner"]
    await bot.handleUpdate(callback(selection.callback_data))
    expect(sessions.setModel).not.toHaveBeenCalled()
    expect(calls[2]?.payload.text).toContain("已無法使用")
  })

  it("shows validation errors and hides unexpected upstream error details", async () => {
    const { bot, sessions, calls } = setup()
    sessions.setThinkingLevel.mockRejectedValueOnce(
      new ModelSettingsError("目前 model 不支援這個 thinking level。"),
    )
    await bot.handleUpdate(callback("thinking:select:high"))
    expect(calls[1]?.payload.text).toContain("不支援")
    sessions.setModel.mockRejectedValueOnce(new Error("fixture private upstream detail"))
    await bot.handleUpdate(command("/model unknown"))
    expect(calls[2]?.payload.text).toContain("無法讀取或切換設定")
    expect(calls[2]?.payload.text).not.toContain("private upstream detail")
    expect(logger.warn).toHaveBeenCalledOnce()
  })

  it("reports missing credentials without prompting", async () => {
    const { bot, sessions, calls } = setup({ models: [] })
    await bot.handleUpdate(command("/model"))
    expect(calls[0]?.payload.text).toContain("目前沒有已驗證")
    expect(sessions.submit).not.toHaveBeenCalled()
  })

  it("enforces the whitelist for both commands and callbacks in groups", async () => {
    const { bot, calls, sessions } = setup()
    await bot.handleUpdate(command("/model", 8, -100))
    await bot.handleUpdate(command("/thinking", 8, -100))
    await bot.handleUpdate(callback("thinking:select:high", 8, -100))
    expect(calls).toHaveLength(0)
    expect(sessions.getModelSettings).not.toHaveBeenCalled()
    expect(sessions.setThinkingLevel).not.toHaveBeenCalled()
    await bot.handleUpdate(callback("thinking:select:high", 7, -100))
    expect(sessions.setThinkingLevel).toHaveBeenCalledExactlyOnceWith(-100, "high")
  })

  it("allows users in an allowlisted chat to select that chat's settings", async () => {
    const { bot, sessions } = setup({ whitelist: "-100" })
    await bot.handleUpdate(command("/model openai/plain", 8, -100))
    await bot.handleUpdate(callback("thinking:select:low", 8, -100))
    expect(sessions.setModel).toHaveBeenCalledExactlyOnceWith(-100, "openai/plain")
    expect(sessions.setThinkingLevel).toHaveBeenCalledExactlyOnceWith(-100, "low")
  })

  it("advertises both commands in help", async () => {
    const { bot, calls } = setup()
    await bot.handleUpdate(command("/help"))
    expect(calls[0]?.payload.text).toContain("/model")
    expect(calls[0]?.payload.text).toContain("/thinking")
  })

  it("registers the command menu at startup before polling", async () => {
    const { start, stop, calls } = setup()
    await start()
    expect(calls[0]).toMatchObject({
      method: "setMyCommands",
      payload: {
        commands: expect.arrayContaining([
          { command: "model", description: expect.any(String) },
          { command: "thinking", description: expect.any(String) },
        ]),
      },
    })
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
