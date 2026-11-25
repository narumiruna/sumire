import type { PublicUrlLoader } from "@narumitw/sumire-pi-url-reader"
import type { Transformer } from "grammy"
import type { InlineKeyboardMarkup, Update, UserFromGetMe } from "grammy/types"
import { describe, expect, it, vi } from "vitest"

import type {
  ChatSessionRegistry,
  SubmissionOptions,
  SubmissionResult,
} from "../src/agent/session-registry.js"
import { loadSettings } from "../src/config/settings.js"
import type { Logger } from "../src/logging.js"
import { createTelegramAgentBot } from "../src/telegram/bot.js"
import { approvedStore } from "./helpers/admin-store.js"
import { telegramPayloadText } from "./helpers/telegram-payload.js"

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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(articleUrlLoader?: PublicUrlLoader) {
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const pending = new Map<number, ReturnType<typeof deferred<SubmissionResult>>>()
  const submissions = new Map<number, SubmissionOptions>()
  const settle = (chatId: number, text = "完成") =>
    pending.get(chatId)?.resolve({ kind: "completed", text })
  const sessions = {
    submit: vi.fn(async (chatId: number, _prompt: string, options: SubmissionOptions) => {
      const task = deferred<SubmissionResult>()
      pending.set(chatId, task)
      submissions.set(chatId, options)
      options.onAccepted?.()
      options.onProgress?.([{ text: "執行任務", status: "in_progress" }])
      return task.promise
    }),
    cancel: vi.fn(async (chatId: number) => {
      settle(chatId, "已中止")
      return true
    }),
    reset: vi.fn(async (chatId: number) => {
      settle(chatId, "已重設")
    }),
    recordDelivery: vi.fn(async () => undefined),
    trackPendingInput: vi.fn(() => () => {}),
    holdReplyCheckpoint: vi.fn(() => () => {}),
    isPendingStatus: vi.fn(async () => false),
    appendPassiveContext: vi.fn(async () => undefined),
  }
  const control = approvedStore([7, -100, -200])
  const telegram = createTelegramAgentBot(
    loadSettings({ BOT_ADMIN_ID: "7", BOT_TOKEN: "test-token" }),
    sessions as unknown as ChatSessionRegistry,
    logger,
    {
      control,
      botInfo,
      articleUrlLoader,
      morselPublisher: {
        isConfigured: true,
        publish: vi.fn(async () => "https://example.test/article"),
      },
    },
  )
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  let nextMessageId = 100
  let nextUpdateId = 1
  const fail = new Set<string>()
  const transformer: Transformer = async (_previous, method, payload) => {
    const p = payload as Record<string, unknown>
    calls.push({ method, payload: p })
    if (fail.has(method)) throw new Error(`Synthetic ${method} failure`)
    if (method === "sendRichMessage" || method === "editMessageText") {
      return {
        ok: true,
        result: {
          message_id: method === "sendRichMessage" ? nextMessageId++ : Number(p.message_id),
          date: 1700000000,
          from: botInfo,
          chat: chat(Number(p.chat_id)),
          rich_message: { blocks: [{ type: "paragraph", text: telegramPayloadText(p) ?? "" }] },
        },
      } as never
    }
    return { ok: true, result: true } as never
  }
  telegram.bot.api.config.use(transformer)
  function chat(chatId: number) {
    return chatId > 0
      ? { id: chatId, type: "private" as const, first_name: "Alice" }
      : { id: chatId, type: "supergroup" as const, title: "Test group" }
  }
  function message(chatId = -100, userId = 8, text = "@test_bot 開始任務"): Update {
    const updateId = nextUpdateId++
    return {
      update_id: updateId,
      message: {
        message_id: updateId,
        date: 1700000000,
        chat: chat(chatId),
        from: { id: userId, is_bot: false, first_name: "User" },
        text,
        entities: text.startsWith("/")
          ? [{ type: "bot_command", offset: 0, length: text.length }]
          : [{ type: "mention", offset: 0, length: 9 }],
      },
    }
  }
  function button(chatId = -100) {
    const sent = calls.findLast(
      (call) => call.method === "sendRichMessage" && call.payload.chat_id === chatId,
    )
    const keyboard = sent?.payload.reply_markup as InlineKeyboardMarkup
    const button = keyboard.inline_keyboard[0]?.[0]
    if (!button || !("callback_data" in button)) throw new Error("Missing abort button")
    return { data: button.callback_data, messageId: nextMessageId - 1, chatId }
  }
  async function click(
    target = button(),
    userId = 8,
    overrides: { chatId?: number; messageId?: number; bot?: boolean } = {},
  ) {
    const updateId = nextUpdateId++
    await telegram.bot.handleUpdate({
      update_id: updateId,
      callback_query: {
        id: `callback-${updateId}`,
        chat_instance: "fixture",
        data: target.data,
        from: { id: userId, is_bot: overrides.bot ?? false, first_name: "User" },
        message: {
          message_id: overrides.messageId ?? target.messageId,
          date: 1700000000,
          chat: chat(overrides.chatId ?? target.chatId),
          from: botInfo,
          text: "處理中…",
        },
      },
    })
  }
  const start = (chatId = -100, userId = 8) => telegram.bot.handleUpdate(message(chatId, userId))
  const ready = (chatId = -100) => vi.waitFor(() => expect(submissions.has(chatId)).toBe(true))
  return {
    telegram,
    calls,
    logger,
    control,
    sessions,
    submissions,
    settle,
    start,
    ready,
    button,
    click,
    message,
    fail,
  }
}

describe("Telegram abort streaming button", () => {
  it("attaches a short callback to pending messages, preserves it on progress, and removes it on completion", async () => {
    const f = fixture()
    const running = f.start()
    await f.ready()
    const target = f.button()
    expect(new TextEncoder().encode(target.data).length).toBeLessThanOrEqual(64)
    await vi.waitFor(() =>
      expect(
        f.calls.some((call) => call.method === "editMessageText" && call.payload.reply_markup),
      ).toBe(true),
    )
    expect(f.calls.find((call) => call.method === "editMessageText")?.payload.reply_markup).toEqual(
      f.calls[0]?.payload.reply_markup,
    )
    f.settle(-100)
    await running
    expect(f.calls).toContainEqual({
      method: "editMessageReplyMarkup",
      payload: {
        chat_id: -100,
        message_id: target.messageId,
        reply_markup: { inline_keyboard: [] },
      },
    })
    await f.click(target)
    expect(f.sessions.cancel).not.toHaveBeenCalled()
  })

  it("lets the initiator cancel through the existing chat path and suppresses the final answer", async () => {
    const f = fixture()
    const running = f.start()
    await f.ready()
    await f.click()
    await running
    expect(f.sessions.cancel).toHaveBeenCalledExactlyOnceWith(-100)
    expect(f.calls.some((call) => telegramPayloadText(call.payload) === "此請求已取消。")).toBe(
      true,
    )
    expect(f.calls.some((call) => telegramPayloadText(call.payload) === "已中止")).toBe(false)
  })

  it("allows the bot administrator, but rejects other group members and bot accounts", async () => {
    const f = fixture()
    const running = f.start()
    await f.ready()
    const target = f.button()
    await f.click(target, 9)
    await f.click(target, 8, { bot: true })
    expect(f.sessions.cancel).not.toHaveBeenCalled()
    expect(
      f.calls.filter((call) => call.method === "answerCallbackQuery" && call.payload.show_alert),
    ).toHaveLength(2)
    await f.click(target, 7)
    await running
    expect(f.sessions.cancel).toHaveBeenCalledExactlyOnceWith(-100)
  })

  it("rejects a valid token on a different chat or message", async () => {
    const f = fixture()
    const running = f.start()
    await f.ready()
    const target = f.button()
    await f.click(target, 8, { chatId: -200 })
    await f.click(target, 8, { messageId: target.messageId + 1 })
    expect(f.sessions.cancel).not.toHaveBeenCalled()
    f.settle(-100)
    await running
  })

  it("rechecks current chat policy before cancellation", async () => {
    const f = fixture()
    const running = f.start()
    await f.ready()
    vi.spyOn(f.control, "allows").mockReturnValue(false)
    await f.click()
    expect(f.sessions.cancel).not.toHaveBeenCalled()
    f.settle(-100)
    await running
  })

  it("does not let an old button cancel a newer task in the same chat", async () => {
    const f = fixture()
    const first = f.start()
    await f.ready()
    const old = f.button()
    f.settle(-100)
    await first
    f.submissions.clear()
    const second = f.start()
    await f.ready()
    expect(f.button().data).not.toBe(old.data)
    await f.click(old)
    expect(f.sessions.cancel).not.toHaveBeenCalled()
    f.settle(-100)
    await second
  })

  it("invalidates double clicks before awaiting the durable abort and leaves peer chats running", async () => {
    const f = fixture()
    const first = f.start()
    await f.ready()
    const target = f.button()
    const peer = f.start(-200)
    await f.ready(-200)
    const blocked = deferred<void>()
    f.sessions.cancel.mockImplementationOnce(async (chatId) => {
      await blocked.promise
      f.settle(chatId)
      return true
    })
    const click = f.click(target)
    await vi.waitFor(() => expect(f.sessions.cancel).toHaveBeenCalledTimes(1))
    await f.click(target)
    expect(f.sessions.cancel).toHaveBeenCalledTimes(1)
    expect(f.submissions.get(-200)?.isCurrent?.()).toBe(true)
    blocked.resolve()
    await click
    await first
    f.settle(-200)
    await peer
  })

  it.each(["cancel", "reset"])("makes the button stale after /%s", async (command) => {
    const f = fixture()
    const running = f.start()
    await f.ready()
    const target = f.button()
    await f.telegram.bot.handleUpdate(f.message(-100, 8, `/${command}`))
    await running
    const count = f.sessions.cancel.mock.calls.length
    await f.click(target)
    expect(f.sessions.cancel).toHaveBeenCalledTimes(count)
  })

  it("still cancels if callback acknowledgement fails", async () => {
    const f = fixture()
    const running = f.start()
    await f.ready()
    f.fail.add("answerCallbackQuery")
    await f.click()
    await running
    expect(f.sessions.cancel).toHaveBeenCalledExactlyOnceWith(-100)
    expect(f.logger.warn).toHaveBeenCalledWith(
      "Could not acknowledge Telegram abort button",
      expect.any(Error),
    )
  })

  it("supports private-chat cancellation", async () => {
    const f = fixture()
    const running = f.start(7, 7)
    await f.ready(7)
    await f.click(f.button(7), 7)
    await running
    expect(f.sessions.cancel).toHaveBeenCalledExactlyOnceWith(7)
  })

  it("rejects unknown tokens, including buttons left over from an earlier process", async () => {
    const f = fixture()
    await f.click({ data: "abort:unknown", chatId: -100, messageId: 100 })
    expect(f.sessions.cancel).not.toHaveBeenCalled()
    expect(f.calls[0]?.payload.text).toContain("已過期")
  })

  it("removes the button on a model failure", async () => {
    const f = fixture()
    f.sessions.submit.mockRejectedValueOnce(new Error("Synthetic model failure"))
    await f.start()
    expect(f.calls.some((call) => call.method === "editMessageReplyMarkup")).toBe(true)
    expect(
      f.calls.some(
        (call) => telegramPayloadText(call.payload) === "AI 服務暫時無法使用，請稍後再試。",
      ),
    ).toBe(true)
    await f.click()
    expect(f.sessions.cancel).not.toHaveBeenCalled()
  })

  it("reports a failed abort without treating it as successful", async () => {
    const f = fixture()
    const running = f.start()
    await f.ready()
    f.sessions.cancel.mockRejectedValueOnce(new Error("Synthetic abort failure"))
    await f.click()
    expect(
      f.calls.some((call) => call.payload.text === "停止任務時發生錯誤，請稍後使用 /cancel 重試。"),
    ).toBe(true)
    f.settle(-100)
    await running
    expect(f.calls.some((call) => telegramPayloadText(call.payload) === "完成")).toBe(false)
  })

  it("cancels article-source loading before a model submission exists", async () => {
    const started = deferred<void>()
    let signal: AbortSignal | undefined
    const load = vi.fn<PublicUrlLoader["load"]>(async (_url, options) => {
      signal = options?.signal
      started.resolve()
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Cancelled", "AbortError")),
          { once: true },
        )
      })
    })
    const f = fixture({ load })
    const update = f.message(-100, 8, "/f https://example.test/source")
    if (update.message) update.message.entities = [{ type: "bot_command", offset: 0, length: 2 }]
    const running = f.telegram.bot.handleUpdate(update)
    await started.promise
    await f.click()
    await running
    expect(signal?.aborted).toBe(true)
    expect(f.sessions.submit).not.toHaveBeenCalled()
    expect(f.calls.some((call) => telegramPayloadText(call.payload) === "此請求已取消。")).toBe(
      true,
    )
    expect(f.calls.some((call) => call.method === "editMessageReplyMarkup")).toBe(true)
  })

  it("does not lose the answer when removing the keyboard fails", async () => {
    const f = fixture()
    const running = f.start()
    await f.ready()
    const target = f.button()
    f.fail.add("editMessageReplyMarkup")
    f.settle(-100)
    await running
    expect(f.calls.some((call) => telegramPayloadText(call.payload) === "完成")).toBe(true)
    await f.click(target)
    expect(f.sessions.cancel).not.toHaveBeenCalled()
  })
})
