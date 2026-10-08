import type { OAuthLoginClient } from "@narumitw/sumire-login"
import { GrammyError } from "grammy"
import type { InlineKeyboardMarkup, Update, UserFromGetMe } from "grammy/types"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
  const faults = new Map<string, unknown>()
  function failNext(method: string, error: unknown) {
    faults.set(method, error)
  }
  telegram.bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> })
    if (faults.has(method)) {
      const error = faults.get(method)
      faults.delete(method)
      throw error
    }
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
  return { ...telegram, state, sessions, calls, buttons, failNext }
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function telegramError(code: number, retryAfter?: number) {
  return new GrammyError(
    "private fixture detail",
    {
      ok: false,
      error_code: code,
      description: "private fixture description",
      parameters: retryAfter === undefined ? {} : { retry_after: retryAfter },
    },
    "editMessageText",
    {},
  )
}

describe("Settings UI callback safety", () => {
  it.each(["model:page:1", "model:select", "thinking:select:high"])(
    "ignores concurrent callbacks for one message: %s",
    async (kind) => {
      const { bot, sessions, calls, buttons, state } = setup({
        models: Array.from({ length: 10 }, (_, i) => `openai/model-${i}`),
      })
      await bot.handleUpdate(command("/model"))
      const selection = buttons()[1]
      if (!selection || !("callback_data" in selection)) throw new Error("Missing selection")
      const data = kind === "model:select" ? selection.callback_data : kind
      let release!: () => void
      let entered!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const started = new Promise<void>((resolve) => {
        entered = resolve
      })
      const operation = kind.startsWith("thinking")
        ? sessions.setThinkingLevel
        : sessions.getModelSettings
      operation.mockImplementationOnce(async () => {
        entered()
        await gate
        return state
      })
      const first = bot.handleUpdate(callback(data))
      await started
      const callsBefore = operation.mock.calls.length
      await bot.handleUpdate(callback(data))
      expect(operation).toHaveBeenCalledTimes(callsBefore)
      expect(calls.filter((call) => call.method === "answerCallbackQuery")).toHaveLength(2)
      expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(0)
      release()
      await first
      expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(1)
      if (kind === "model:select") expect(sessions.setModel).toHaveBeenCalledOnce()
    },
  )

  it("allows different messages and chats while one message is busy", async () => {
    const { bot, sessions, state } = setup({ whitelist: "7,8" })
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    sessions.setThinkingLevel.mockImplementationOnce(async () => {
      entered()
      await gate
      return state
    })
    const first = bot.handleUpdate(callback("thinking:select:high"))
    await started
    await bot.handleUpdate(callback("thinking:select:low", 7, undefined, { messageId: 101 }))
    await bot.handleUpdate(callback("thinking:select:max", 8))
    expect(sessions.setThinkingLevel).toHaveBeenCalledTimes(3)
    release()
    await first
  })

  it("skips identical pages using the callback snapshot and later successful edits", async () => {
    const { bot, calls } = setup({
      models: Array.from({ length: 10 }, (_, i) => `openai/model-${i}`),
    })
    await bot.handleUpdate(command("/model"))
    const original = calls[0]?.payload
    // Even a stale callback can use the successful initial send snapshot.
    await bot.handleUpdate(callback("model:page:0"))
    await bot.handleUpdate(
      callback("model:page:0", 7, undefined, {
        messageId: 101,
        text: String(original?.text),
        replyMarkup: original?.reply_markup as InlineKeyboardMarkup,
      }),
    )
    expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(0)
    await bot.handleUpdate(callback("model:page:1"))
    await bot.handleUpdate(callback("model:page:1"))
    expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(1)
    // The old page-0 snapshot must not override the successful page-1 edit.
    await bot.handleUpdate(
      callback("model:page:0", 7, undefined, {
        text: String(original?.text),
        replyMarkup: original?.reply_markup as InlineKeyboardMarkup,
      }),
    )
    expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(2)
  })

  it("skips repeated confirmation edits and still updates changed text", async () => {
    const { bot, calls } = setup()
    await bot.handleUpdate(callback("thinking:select:high"))
    await bot.handleUpdate(callback("thinking:select:high"))
    expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(1)
    await bot.handleUpdate(callback("thinking:select:low"))
    expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(2)
  })

  it("edits when only the keyboard changes", async () => {
    const { bot, calls } = setup()
    await bot.handleUpdate(command("/model"))
    await bot.handleUpdate(
      callback("model:page:0", 7, undefined, {
        messageId: 101,
        text: String(calls[0]?.payload.text),
        replyMarkup: { inline_keyboard: [] },
      }),
    )
    expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(1)
  })

  it.each([telegramError(400), new Error("private network fixture")])(
    "logs transport failure without settings warnings, releases the lock, and does not cache failed edits",
    async (error) => {
      const { bot, sessions, calls, failNext } = setup()
      failNext("editMessageText", error)
      await bot.handleUpdate(callback("thinking:select:high"))
      expect(sessions.setThinkingLevel).toHaveBeenCalledOnce()
      expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(1)
      expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(0)
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        "Telegram model settings delivery failed",
        {
          operation: "edit",
          error_code: error instanceof GrammyError ? 400 : undefined,
          retry_after: undefined,
        },
      )
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private")
      await bot.handleUpdate(callback("thinking:select:high"))
      expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(2)
    },
  )

  it("isolates acknowledgement failure and permits a subsequent callback", async () => {
    const { bot, sessions, calls, failNext } = setup()
    failNext("answerCallbackQuery", telegramError(400))
    await bot.handleUpdate(callback("thinking:select:high"))
    expect(sessions.setThinkingLevel).not.toHaveBeenCalled()
    expect(calls.map((call) => call.method)).toEqual(["answerCallbackQuery"])
    expect(logger.warn).toHaveBeenCalledWith(
      "Telegram model settings delivery failed",
      expect.objectContaining({ operation: "acknowledge", error_code: 400 }),
    )
    await bot.handleUpdate(callback("thinking:select:high"))
    expect(sessions.setThinkingLevel).toHaveBeenCalledOnce()
  })

  it.each(["editMessageText", "sendMessage", "answerCallbackQuery"] as const)(
    "honors 429 from %s across settings UI chats and resumes after retry_after",
    async (method) => {
      vi.useFakeTimers()
      const { bot, sessions, calls, failNext } = setup({ whitelist: "7,8" })
      failNext(method, telegramError(429, 21))
      if (method === "sendMessage") await bot.handleUpdate(command("/thinking high"))
      else await bot.handleUpdate(callback("thinking:select:high"))
      const count = calls.length
      const changes = sessions.setThinkingLevel.mock.calls.length
      await bot.handleUpdate(callback("thinking:select:low", 8))
      await bot.handleUpdate(command("/model", 8))
      await bot.handleUpdate(command("/thinking low", 8))
      expect(calls).toHaveLength(count)
      expect(sessions.setThinkingLevel).toHaveBeenCalledTimes(changes)
      expect(sessions.getModelSettings).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(20_999)
      await bot.handleUpdate(callback("thinking:select:low"))
      expect(calls).toHaveLength(count)
      await vi.advanceTimersByTimeAsync(1)
      await bot.handleUpdate(callback("thinking:select:low"))
      expect(sessions.setThinkingLevel).toHaveBeenCalledTimes(changes + 1)
      expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(
        method === "sendMessage" ? 1 : 0,
      )
    },
  )

  it.each([400, 429])(
    "contains a failed error reply (%s) and releases the callback lock",
    async (code) => {
      vi.useFakeTimers()
      const { bot, sessions, calls, failNext } = setup()
      sessions.setThinkingLevel.mockRejectedValueOnce(new ModelSettingsError("unsupported"))
      failNext("sendMessage", telegramError(code, code === 429 ? 21 : undefined))
      await bot.handleUpdate(callback("thinking:select:high"))
      expect(calls.filter((call) => call.method === "sendMessage")).toHaveLength(1)
      expect(logger.warn).toHaveBeenCalledOnce()
      if (code === 429) {
        await bot.handleUpdate(callback("thinking:select:high"))
        expect(sessions.setThinkingLevel).toHaveBeenCalledOnce()
        await vi.advanceTimersByTimeAsync(21_000)
      }
      await bot.handleUpdate(callback("thinking:select:high"))
      expect(sessions.setThinkingLevel).toHaveBeenCalledTimes(2)
    },
  )

  it("does not release another callback's lock when a busy acknowledgement fails", async () => {
    const { bot, sessions, state, failNext } = setup()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    sessions.setThinkingLevel.mockImplementationOnce(async () => {
      entered()
      await gate
      return state
    })
    const first = bot.handleUpdate(callback("thinking:select:high"))
    await started
    failNext("answerCallbackQuery", telegramError(400))
    await bot.handleUpdate(callback("thinking:select:low"))
    await bot.handleUpdate(callback("thinking:select:max"))
    expect(sessions.setThinkingLevel).toHaveBeenCalledOnce()
    release()
    await first
    await bot.handleUpdate(callback("thinking:select:low"))
    expect(sessions.setThinkingLevel).toHaveBeenCalledTimes(2)
  })

  it("ignores inaccessible callback messages without changing settings", async () => {
    const { bot, sessions, calls } = setup()
    const update = callback("thinking:select:high")
    if (!update.callback_query?.message) throw new Error("Missing callback message")
    update.callback_query.message = {
      message_id: 100,
      date: 0,
      chat: { id: 7, type: "private", first_name: "Alice" },
    }
    await bot.handleUpdate(update)
    expect(sessions.setThinkingLevel).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it("expires successful edit snapshots after five minutes without retaining timers", async () => {
    vi.useFakeTimers()
    const { bot, calls } = setup()
    await bot.handleUpdate(callback("thinking:select:high"))
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1)
    await bot.handleUpdate(callback("thinking:select:high"))
    expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    await bot.handleUpdate(callback("thinking:select:high"))
    expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("retains only the most recent 256 successful message snapshots", async () => {
    const { bot, calls } = setup()
    for (let messageId = 100; messageId <= 356; messageId++) {
      await bot.handleUpdate(callback("thinking:select:high", 7, undefined, { messageId }))
    }
    await bot.handleUpdate(callback("thinking:select:high", 7, undefined, { messageId: 356 }))
    expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(257)
    await bot.handleUpdate(callback("thinking:select:high"))
    expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(258)
  })

  it("suppresses in-flight delivery after another message enters cooldown without replaying a setting", async () => {
    vi.useFakeTimers()
    const { bot, sessions, state, calls, failNext } = setup()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    sessions.setThinkingLevel.mockImplementationOnce(async () => {
      entered()
      await gate
      return state
    })
    const first = bot.handleUpdate(callback("thinking:select:high"))
    await started
    failNext("editMessageText", telegramError(429, 21))
    await bot.handleUpdate(callback("thinking:select:low", 7, undefined, { messageId: 101 }))
    release()
    await first
    expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(21_000)
    expect(sessions.setThinkingLevel).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    await bot.handleUpdate(callback("thinking:select:high"))
    expect(sessions.setThinkingLevel).toHaveBeenCalledTimes(3)
  })

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "uses a finite fallback cooldown for malformed retry_after: %s",
    async (retryAfter) => {
      vi.useFakeTimers()
      const { bot, sessions, failNext } = setup()
      failNext("answerCallbackQuery", telegramError(429, retryAfter))
      await bot.handleUpdate(callback("thinking:select:high"))
      await bot.handleUpdate(callback("thinking:select:high"))
      expect(sessions.setThinkingLevel).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1_000)
      await bot.handleUpdate(callback("thinking:select:high"))
      expect(sessions.setThinkingLevel).toHaveBeenCalledOnce()
    },
  )

  it("does not leak unknown settings errors and recovers after rejection", async () => {
    const { bot, sessions, calls } = setup()
    sessions.setThinkingLevel.mockRejectedValueOnce(new Error("private upstream URL"))
    await bot.handleUpdate(callback("thinking:select:high"))
    expect(calls[1]?.payload.text).toContain("無法讀取或切換設定")
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private")
    await bot.handleUpdate(callback("thinking:select:high"))
    expect(sessions.setThinkingLevel).toHaveBeenCalledTimes(2)
  })
})

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
