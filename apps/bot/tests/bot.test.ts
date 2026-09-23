import type { ProgressStep } from "@narumitw/sumire-progress"
import type { Transformer } from "grammy"
import type { Update, UserFromGetMe } from "grammy/types"
import { describe, expect, it, vi } from "vitest"
import type { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { loadSettings } from "../src/config/settings.js"
import { AnyDocConverter, DocumentConversionError } from "../src/documents/converter.js"
import type { Logger } from "../src/logging.js"
import { queryMarketData } from "../src/market-data/query.js"
import { createTelegramAgentBot } from "../src/telegram/bot.js"

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

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

function createSessions(overrides: Partial<ChatSessionRegistry> = {}): ChatSessionRegistry {
  return {
    submit: vi.fn(
      async (
        _chatId: number,
        _prompt: string,
        options: {
          onAccepted?: () => void
          onProgress?: (steps: readonly ProgressStep[]) => void
          isCurrent?: () => boolean
        } = {},
      ) => {
        options.onAccepted?.()
        return { kind: "completed" as const, text: "AI 回覆" }
      },
    ),
    recordDelivery: vi.fn(async () => undefined),
    appendPassiveContext: vi.fn(async () => undefined),
    cancel: vi.fn(async () => false),
    reset: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as ChatSessionRegistry
}

function privateMessage(updateId: number, text: string, userId = 7): Update {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      chat: { id: userId, type: "private", first_name: "Alice" },
      from: { id: userId, is_bot: false, first_name: "Alice" },
      text,
    },
  }
}

function commandMessage(updateId: number, text: string, userId = 7): Update {
  const update = privateMessage(updateId, text, userId)
  const command = text.split(/\s/u, 1)[0] ?? text
  if (update.message) {
    update.message.entities = [{ offset: 0, length: command.length, type: "bot_command" }]
  }
  return update
}

function repliedDocumentCommand(updateId: number, text = "/ask 請摘要"): Update {
  const update = commandMessage(updateId, text)
  if (update.message) {
    update.message.reply_to_message = {
      message_id: 50,
      date: 1_700_000_000,
      chat: update.message.chat,
      from: { id: 8, is_bot: false, first_name: "Bob" },
      document: {
        file_id: "replied-document",
        file_unique_id: "replied-document",
        file_name: "report.csv",
        mime_type: "text/csv",
        file_size: 5,
      },
      reply_to_message: undefined,
    }
  }
  return update
}

function installApiMock(
  bot: ReturnType<typeof createTelegramAgentBot>["bot"],
  beforeResponse: (
    method: string,
    payload: Record<string, unknown>,
  ) => Promise<void> | void = () => {},
) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  let nextMessageId = 100
  const transformer: Transformer = async (_previous, method, payload) => {
    const recordedPayload = payload as Record<string, unknown>
    calls.push({ method, payload: recordedPayload })
    await beforeResponse(method, recordedPayload)
    if (method === "sendMessage") {
      return {
        ok: true,
        result: {
          message_id: nextMessageId++,
          date: 1_700_000_001,
          chat: { id: Number(recordedPayload.chat_id), type: "private", first_name: "Alice" },
          text: String(recordedPayload.text),
        },
      } as never
    }
    if (method === "getFile") {
      return {
        ok: true,
        result: {
          file_id: String(recordedPayload.file_id),
          file_unique_id: "image-unique-id",
          file_size: 5,
          file_path: "photos/image.jpg",
        },
      } as never
    }
    return { ok: true, result: true } as never
  }
  bot.api.config.use(transformer)
  return calls
}

describe("Telegram bot update routing", () => {
  it("documents commands without advertising disabled coding tools", async () => {
    const sessions = createSessions()
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      { botInfo },
    )
    const calls = installApiMock(telegram.bot)

    await telegram.bot.handleUpdate(commandMessage(1, "/help"))

    expect(calls[0]?.payload.text).toContain("/f <內容>")
    expect(calls[0]?.payload.text).toContain("/t <代碼>")
    expect(calls[0]?.payload.text).not.toContain("read、bash、edit、write")
    expect(sessions.submit).not.toHaveBeenCalled()
  })

  it("documents explicitly enabled coding tools in help", async () => {
    const sessions = createSessions()
    const telegram = createTelegramAgentBot(
      loadSettings({
        BOT_TOKEN: "test-token",
        BOT_CODING_TOOLS_ENABLED: "true",
        BOT_WHITELIST: "7",
      }),
      sessions,
      logger,
      { botInfo },
    )
    const calls = installApiMock(telegram.bot)

    await telegram.bot.handleUpdate(commandMessage(7, "/help"))

    expect(calls[0]?.payload.text).toContain("read、bash、edit、write")
    expect(sessions.submit).not.toHaveBeenCalled()
  })

  it("rewrites /f input through Pi and publishes only the article URL", async () => {
    const article = "# 整理後的標題\n\n## 📝 重點\n\n整理後的內容。"
    const checkpoint = { sessionId: "session", entryId: "entry", generation: 0 }
    const sessions = createSessions({
      submit: vi.fn(async (_chatId, _prompt, options) => {
        options.onAccepted?.()
        return { kind: "completed" as const, text: article, checkpoint }
      }),
    })
    const publish = vi.fn(async () => "https://morsel.example/s/article")
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token", MORSEL_API_KEY: "secret" }),
      sessions,
      logger,
      { botInfo, morselPublisher: { isConfigured: true, publish } },
    )
    const calls = installApiMock(telegram.bot)

    await telegram.bot.handleUpdate(commandMessage(20, "/f 原始內容 https://example.com/article"))

    expect(sessions.submit).toHaveBeenCalledOnce()
    const [chatId, prompt, options] = vi.mocked(sessions.submit).mock.calls[0] ?? []
    expect(chatId).toBe(7)
    expect(options?.intent).toBe("newTurn")
    expect(prompt).toContain("written entirely in 台灣正體中文")
    expect(prompt).toContain("use load_public_url")
    expect(prompt).toContain("原始內容 https://example.com/article")
    expect(prompt).not.toContain("/f 原始內容")
    expect(publish).toHaveBeenCalledExactlyOnceWith(article)
    expect(calls.map((call) => call.method)).toEqual(["sendMessage"])
    expect(calls[0]?.payload.text).toContain("https://morsel.example/s/article")
    expect(calls[0]?.payload.text).not.toContain(article)
    expect(calls[0]?.payload.reply_parameters).toEqual({
      message_id: 20,
      allow_sending_without_reply: true,
    })
    expect(sessions.recordDelivery).toHaveBeenCalledWith(7, checkpoint, [100])
  })

  it.each(["photo", "document"] as const)(
    "routes /f in current %s captions through the article workflow",
    async (kind) => {
      const sessions = createSessions()
      const documentConverter = {
        convert: vi.fn(async (loadBytes: () => Promise<Uint8Array>) => {
          expect(await loadBytes()).toEqual(Buffer.from("media bytes"))
          return {
            markdown: "# Converted document",
            format: "csv",
            originalChars: 20,
            truncated: false,
          }
        }),
      }
      const publish = vi.fn(async () => "https://morsel.example/s/article")
      const telegram = createTelegramAgentBot(
        loadSettings({ BOT_TOKEN: "test-token", MORSEL_API_KEY: "secret" }),
        sessions,
        logger,
        {
          botInfo,
          documentConverter,
          imageFetchImplementation: vi.fn(async () => new Response("media bytes")),
          morselPublisher: { isConfigured: true, publish },
        },
      )
      installApiMock(telegram.bot)
      const update = privateMessage(21, "")
      if (update.message) {
        delete update.message.text
        update.message.caption = "/f 補充內容"
        update.message.caption_entities = [{ type: "bot_command", offset: 0, length: 2 }]
        if (kind === "photo") {
          update.message.photo = [
            {
              file_id: "photo",
              file_unique_id: "photo",
              width: 100,
              height: 100,
              file_size: 5,
            },
          ]
        } else {
          update.message.document = {
            file_id: "document",
            file_unique_id: "document",
            file_name: "report.csv",
            mime_type: "text/csv",
            file_size: 5,
          }
        }
      }

      await telegram.bot.handleUpdate(update)

      const [, prompt, options] = vi.mocked(sessions.submit).mock.calls[0] ?? []
      expect(prompt).toContain("written entirely in 台灣正體中文")
      expect(prompt).toContain("補充內容")
      expect(prompt).not.toContain("/f 補充內容")
      expect(options?.images).toHaveLength(kind === "photo" ? 1 : 0)
      expect(documentConverter.convert).toHaveBeenCalledTimes(kind === "document" ? 1 : 0)
      expect(publish).toHaveBeenCalledExactlyOnceWith("AI 回覆")
    },
  )

  it("uses a replied message as the source of a bare /f command", async () => {
    const sessions = createSessions()
    const publish = vi.fn(async () => "https://morsel.example/s/article")
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token", MORSEL_API_KEY: "secret" }),
      sessions,
      logger,
      { botInfo, morselPublisher: { isConfigured: true, publish } },
    )
    const calls = installApiMock(telegram.bot)
    const update = commandMessage(21, "/f")
    if (update.message) {
      update.message.reply_to_message = {
        message_id: 19,
        date: 1_700_000_000,
        chat: update.message.chat,
        from: { id: 8, is_bot: false, first_name: "Bob" },
        text: "要整理的回覆內容",
        reply_to_message: undefined,
      }
    }

    await telegram.bot.handleUpdate(update)

    const [, prompt] = vi.mocked(sessions.submit).mock.calls[0] ?? []
    expect(prompt).toContain("Content: 要整理的回覆內容")
    expect(prompt).toContain("Treat the replied message as the primary object")
    expect(prompt).toContain('<source_context trust="untrusted">')
    expect(publish).toHaveBeenCalledExactlyOnceWith("AI 回覆")
    expect(calls[0]?.payload.text).toContain("https://morsel.example/s/article")
  })

  it("includes a replied bot answer in /f source and reply-tree fallback context", async () => {
    const sessions = createSessions()
    const publish = vi.fn(async () => "https://morsel.example/s/article")
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token", MORSEL_API_KEY: "secret" }),
      sessions,
      logger,
      { botInfo, morselPublisher: { isConfigured: true, publish } },
    )
    installApiMock(telegram.bot)
    const update = commandMessage(22, "/f")
    if (update.message) {
      update.message.reply_to_message = {
        message_id: 50,
        date: 1_700_000_000,
        chat: update.message.chat,
        from: botInfo,
        text: "較早的 bot 回覆",
        reply_to_message: undefined,
      }
    }

    await telegram.bot.handleUpdate(update)

    const [, prompt, options] = vi.mocked(sessions.submit).mock.calls[0] ?? []
    expect(prompt).toContain("Content: 較早的 bot 回覆")
    expect(options?.replyToBotMessageId).toBe(50)
    expect(options?.unresolvedReplyPrompt).toBe(prompt)
  })

  it("does not publish the /f no-response fallback as an article", async () => {
    const sessions = createSessions({
      submit: vi.fn(async (_chatId, _prompt, options) => {
        options.onAccepted?.()
        return { kind: "no_response" as const, text: "模型沒有回覆內容，請稍後再試。" }
      }),
    })
    const publish = vi.fn(async () => "https://morsel.example/s/article")
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token", MORSEL_API_KEY: "secret" }),
      sessions,
      logger,
      { botInfo, morselPublisher: { isConfigured: true, publish } },
    )
    const calls = installApiMock(telegram.bot)

    await telegram.bot.handleUpdate(commandMessage(23, "/f 原始內容"))

    expect(publish).not.toHaveBeenCalled()
    expect(calls[0]?.payload.text).toBe("模型沒有回覆內容，請稍後再試。")
    expect(sessions.recordDelivery).not.toHaveBeenCalled()
  })

  it("does not publish /f steering acknowledgements as articles", async () => {
    const sessions = createSessions({
      submit: vi.fn(async (_chatId, _prompt, options) => {
        options.onAccepted?.()
        return { kind: "steered" as const, text: "已將新訊息加入目前任務。" }
      }),
    })
    const publish = vi.fn(async () => "https://morsel.example/s/article")
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token", MORSEL_API_KEY: "secret" }),
      sessions,
      logger,
      { botInfo, morselPublisher: { isConfigured: true, publish } },
    )
    const calls = installApiMock(telegram.bot)

    await telegram.bot.handleUpdate(commandMessage(23, "/f 原始內容"))

    expect(publish).not.toHaveBeenCalled()
    expect(calls[0]?.payload.text).toBe("已將新訊息加入目前任務。")
  })

  it("rejects unsupported replied media without invoking Pi", async () => {
    const sessions = createSessions()
    const publish = vi.fn(async () => "https://morsel.example/s/article")
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token", MORSEL_API_KEY: "secret" }),
      sessions,
      logger,
      { botInfo, morselPublisher: { isConfigured: true, publish } },
    )
    const calls = installApiMock(telegram.bot)
    const update = commandMessage(24, "/f")
    if (update.message) {
      update.message.reply_to_message = {
        message_id: 23,
        date: 1_700_000_000,
        chat: update.message.chat,
        from: { id: 8, is_bot: false, first_name: "Bob" },
        video: {
          file_id: "video",
          file_unique_id: "video",
          width: 640,
          height: 480,
          duration: 10,
        },
        reply_to_message: undefined,
      }
    }

    await telegram.bot.handleUpdate(update)

    expect(sessions.submit).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(calls[0]?.payload.text).toContain("請使用 /f <內容>")
  })

  it("rejects /f before invoking Pi when Morsel is unavailable", async () => {
    const sessions = createSessions()
    const publish = vi.fn(async () => "https://morsel.example/s/article")
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      { botInfo, morselPublisher: { isConfigured: false, publish } },
    )
    const calls = installApiMock(telegram.bot)

    await telegram.bot.handleUpdate(commandMessage(22, "/f 原始內容"))

    expect(sessions.submit).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(calls[0]?.payload.text).toBe(
      "文章無法發布至 Morsel（原因：MORSEL_API_KEY is not configured），請稍後再試。",
    )
  })

  it("shows /f usage when no source content or attachment is available", async () => {
    const sessions = createSessions()
    const publish = vi.fn(async () => "https://morsel.example/s/article")
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token", MORSEL_API_KEY: "secret" }),
      sessions,
      logger,
      { botInfo, morselPublisher: { isConfigured: true, publish } },
    )
    const calls = installApiMock(telegram.bot)

    await telegram.bot.handleUpdate(commandMessage(22, "/f"))

    expect(sessions.submit).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(calls[0]?.payload.text).toContain("請使用 /f <內容>")
    expect(calls[0]?.payload.reply_parameters).toEqual({ message_id: 22 })
  })

  it("shows /t usage without querying market data", async () => {
    const sessions = createSessions()
    const marketDataQuery = vi.fn(async () => "result")
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      { botInfo, marketDataQuery },
    )
    const calls = installApiMock(telegram.bot)

    await telegram.bot.handleUpdate(commandMessage(2, "/t"))

    expect(marketDataQuery).not.toHaveBeenCalled()
    expect(calls[0]?.payload.text).toContain("/t <代碼>")
  })

  it("answers /t directly without invoking Pi", async () => {
    const sessions = createSessions()
    const marketDataQuery = vi.fn(async () => "📊 Apple Inc. (AAPL)\n現價: 195.25 USD")
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      { botInfo, marketDataQuery },
    )
    const calls = installApiMock(telegram.bot)

    await telegram.bot.handleUpdate(commandMessage(3, "/t aapl"))

    expect(marketDataQuery).toHaveBeenCalledWith("aapl")
    expect(calls[0]?.payload.text).toContain("Apple Inc.")
    expect(calls[0]?.payload.reply_parameters).toEqual({ message_id: 3 })
    expect(sessions.submit).not.toHaveBeenCalled()
  })

  it("reports when /t has no matching market data", async () => {
    const sessions = createSessions()
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      { botInfo, marketDataQuery: async () => "" },
    )
    const calls = installApiMock(telegram.bot)

    await telegram.bot.handleUpdate(commandMessage(4, "/t UNKNOWN"))

    expect(calls[0]?.payload.text).toContain("查不到 UNKNOWN")
    expect(sessions.submit).not.toHaveBeenCalled()
  })

  it("reports temporary /t provider failures through the real market-data query", async () => {
    const sessions = createSessions()
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      {
        botInfo,
        marketDataQuery: (input) =>
          queryMarketData(input, {
            fetchImplementation: async () => new Response(null, { status: 503 }),
          }),
      },
    )
    const calls = installApiMock(telegram.bot)

    await telegram.bot.handleUpdate(commandMessage(5, "/t AAPL"))

    expect(calls[0]?.payload.text).toBe("市場資料服務暫時無法使用，請稍後再試。")
    expect(sessions.submit).not.toHaveBeenCalled()
  })

  it("routes private messages through the Pi session and replies with the final answer", async () => {
    const sessions = createSessions()
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      { botInfo },
    )
    const calls = installApiMock(telegram.bot)

    await telegram.bot.handleUpdate(privateMessage(1, "你好"))

    expect(sessions.submit).toHaveBeenCalledWith(7, "你好", {
      images: [],
      onAccepted: expect.any(Function),
      onProgress: expect.any(Function),
      isCurrent: expect.any(Function),
    })
    expect(calls.map((call) => call.method)).toEqual(["sendMessage"])
    expect(calls[0]?.payload.text).toBe("AI 回覆")
    expect(calls[0]?.payload.reply_parameters).toEqual({
      message_id: 1,
      allow_sending_without_reply: true,
    })
    expect(calls[0]?.payload.parse_mode).toBe("HTML")
  })

  it("renders a progress-free answer as Telegram HTML", async () => {
    const sessions = createSessions({
      submit: vi.fn(async (_chatId, _prompt, options) => {
        options.onAccepted?.()
        return { kind: "completed" as const, text: "# 標題\n**粗體** `<tag>`" }
      }),
    })
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      { botInfo },
    )
    const calls = installApiMock(telegram.bot)

    await telegram.bot.handleUpdate(privateMessage(2, "格式化回答"))

    expect(calls[0]?.payload.text).toBe("<b>標題</b>\n<b>粗體</b> <code>&lt;tag&gt;</code>")
    expect(calls[0]?.payload.parse_mode).toBe("HTML")
  })

  it("does not publish an initial empty progress snapshot", async () => {
    const sessions = createSessions({
      submit: vi.fn(async (_chatId, _prompt, options) => {
        options.onAccepted?.()
        options.onProgress?.([])
        return { kind: "completed" as const, text: "完成" }
      }),
    })
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      { botInfo },
    )
    const calls = installApiMock(telegram.bot)

    await telegram.bot.handleUpdate(privateMessage(2, "簡單問題"))

    expect(calls.map((call) => call.method)).toEqual(["sendMessage"])
    expect(calls[0]?.payload.text).toBe("完成")
  })

  it("clears a previously visible progress snapshot", async () => {
    const sessions = createSessions({
      submit: vi.fn(async (_chatId, _prompt, options) => {
        options.onAccepted?.()
        options.onProgress?.([{ text: "執行中", status: "in_progress" }])
        await new Promise<void>((resolve) => setImmediate(resolve))
        options.onProgress?.([])
        await new Promise<void>((resolve) => setImmediate(resolve))
        return { kind: "completed" as const, text: "完成" }
      }),
    })
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      { botInfo },
    )
    const calls = installApiMock(telegram.bot)

    await telegram.bot.handleUpdate(privateMessage(2, "長任務"))

    expect(calls.map((call) => call.method)).toEqual([
      "sendMessage",
      "editMessageText",
      "editMessageText",
    ])
    expect(calls[0]?.payload.text).toContain("🔄 執行中")
    expect(calls[1]?.payload.text).toBe("進度已清除")
    expect(calls[2]?.payload.text).toBe("完成")
  })

  it("replaces the structured progress reply with the final answer", async () => {
    const sessions = createSessions({
      submit: vi.fn(async (_chatId, _prompt, options) => {
        options.onAccepted?.()
        options.onProgress?.([
          { text: "分析需求", status: "completed" },
          { text: "撰寫回覆", status: "in_progress" },
        ])
        return { kind: "completed" as const, text: "完成" }
      }),
    })
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      { botInfo },
    )
    const calls = installApiMock(telegram.bot)

    await telegram.bot.handleUpdate(privateMessage(2, "請處理"))

    expect(calls.map((call) => call.method)).toEqual(["sendMessage", "editMessageText"])
    expect(calls[0]?.payload.text).toContain("進度 1/2")
    expect(calls[0]?.payload.text).toContain("🔄 撰寫回覆")
    expect(calls[0]?.payload.reply_parameters).toEqual({
      message_id: 2,
      allow_sending_without_reply: true,
    })
    expect(calls[0]?.payload.parse_mode).toBe("HTML")
    expect(calls[1]?.payload.text).toBe("完成")
  })

  it("waits for an active progress reply before publishing the final answer", async () => {
    let finishProgressEdit: (() => void) | undefined
    const pendingProgressEdit = new Promise<void>((resolve) => {
      finishProgressEdit = resolve
    })
    const sessions = createSessions({
      submit: vi.fn(async (_chatId, _prompt, options) => {
        options.onAccepted?.()
        options.onProgress?.([{ text: "執行中", status: "in_progress" }])
        return { kind: "completed" as const, text: "最終答案" }
      }),
    })
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      { botInfo },
    )
    const calls = installApiMock(telegram.bot, async (method, payload) => {
      if (method === "sendMessage" && String(payload.text).startsWith("進度 ")) {
        await pendingProgressEdit
      }
    })

    const handling = telegram.bot.handleUpdate(privateMessage(3, "長任務"))
    await vi.waitFor(() => expect(calls.map((call) => call.method)).toEqual(["sendMessage"]))

    finishProgressEdit?.()
    await handling
    expect(calls.map((call) => call.method)).toEqual(["sendMessage", "editMessageText"])
    expect(calls[1]?.payload.text).toBe("最終答案")
  })

  it("enforces the allowlist before invoking session or Telegram APIs", async () => {
    const sessions = createSessions()
    const settings = loadSettings({ BOT_TOKEN: "test-token", BOT_WHITELIST: "7" })
    const telegram = createTelegramAgentBot(settings, sessions, logger, { botInfo })
    const calls = installApiMock(telegram.bot)

    await telegram.bot.handleUpdate(privateMessage(2, "不應處理", 8))

    expect(sessions.submit).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it("transcribes private voice and replied audio before submitting them to Pi", async () => {
    const sessions = createSessions()
    const transcribe = vi.fn(async (loadBytes: () => Promise<Uint8Array>) => {
      expect(await loadBytes()).toEqual(Buffer.from("audio bytes"))
      return "轉錄內容"
    })
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      {
        botInfo,
        audioTranscriber: { transcribe },
        imageFetchImplementation: vi.fn(async () => new Response("audio bytes")),
      },
    )
    const calls = installApiMock(telegram.bot)
    const voice = privateMessage(90, "")
    if (voice.message) {
      delete voice.message.text
      voice.message.voice = {
        file_id: "voice-id",
        file_unique_id: "voice-unique",
        duration: 5,
        file_size: 11,
      }
    }
    await telegram.bot.handleUpdate(voice)
    expect(sessions.submit).toHaveBeenCalledWith(
      7,
      expect.stringContaining('<audio-transcript source="current" kind="voice" trust="untrusted">'),
      expect.anything(),
    )
    expect(calls.map((call) => call.method)).toEqual(["getFile", "sendMessage"])

    const reply = privateMessage(91, "請摘要")
    if (reply.message) {
      reply.message.reply_to_message = {
        message_id: 80,
        date: 1_700_000_000,
        chat: reply.message.chat,
        from: { id: 8, is_bot: false, first_name: "Bob" },
        audio: { file_id: "audio-id", file_unique_id: "audio-unique", duration: 8 },
        reply_to_message: undefined,
      }
    }
    await telegram.bot.handleUpdate(reply)
    expect(sessions.submit).toHaveBeenCalledWith(
      7,
      expect.stringContaining('<audio-transcript source="replied" kind="audio" trust="untrusted">'),
      expect.anything(),
    )
    expect(transcribe).toHaveBeenCalledTimes(2)
  })

  it("returns a direct error instead of sending failed audio transcription to Pi", async () => {
    const sessions = createSessions()
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      {
        botInfo,
        audioTranscriber: {
          transcribe: vi.fn(async () => {
            throw new Error("Whisper unavailable")
          }),
        },
      },
    )
    const calls = installApiMock(telegram.bot)
    const update = privateMessage(93, "")
    if (update.message) {
      delete update.message.text
      update.message.voice = { file_id: "voice-id", file_unique_id: "voice-unique", duration: 1 }
    }
    await telegram.bot.handleUpdate(update)
    expect(sessions.submit).not.toHaveBeenCalled()
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text).toBe(
      "無法下載或轉錄音訊，請稍後再試。",
    )
  })

  it("rejects disabled, over-duration, and oversized Telegram audio without invoking Pi", async () => {
    for (const [settings, voice, expected] of [
      [{ BOT_AUDIO_INPUT_ENABLED: "false" }, { duration: 1 }, "目前未啟用音訊輸入。"],
      [{ BOT_AUDIO_MAX_DURATION_SECONDS: "10" }, { duration: 11 }, "音訊長度超過允許的限制。"],
      [
        { BOT_AUDIO_MAX_BYTES: "4" },
        { duration: 1, file_size: 5 },
        "音訊超過允許的大小，無法處理。",
      ],
    ] as const) {
      const sessions = createSessions()
      const telegram = createTelegramAgentBot(
        loadSettings({ BOT_TOKEN: "test-token", ...settings }),
        sessions,
        logger,
        { botInfo },
      )
      const calls = installApiMock(telegram.bot)
      const update = privateMessage(92, "")
      if (update.message) {
        delete update.message.text
        update.message.voice = { file_id: "voice-id", file_unique_id: "voice-unique", ...voice }
      }
      await telegram.bot.handleUpdate(update)
      expect(sessions.submit).not.toHaveBeenCalled()
      expect(calls.find((call) => call.method === "sendMessage")?.payload.text).toBe(expected)
      expect(calls.some((call) => call.method === "getFile")).toBe(false)
    }
  })

  it("records unaddressed group updates as passive context", async () => {
    const sessions = createSessions()
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      { botInfo },
    )
    installApiMock(telegram.bot)
    const update: Update = {
      update_id: 3,
      message: {
        message_id: 3,
        date: 1_700_000_000,
        chat: { id: -100, type: "supergroup", title: "測試群組" },
        from: { id: 136_817_688, is_bot: true, first_name: "Channel", username: "Channel_Bot" },
        sender_chat: { id: -200, type: "channel", title: "公告頻道" },
        text: "頻道公告",
      },
    }

    await telegram.bot.handleUpdate(update)

    expect(sessions.appendPassiveContext).toHaveBeenCalledWith(
      -100,
      "[群組旁聽訊息 from 公告頻道] 頻道公告",
    )
    expect(sessions.submit).not.toHaveBeenCalled()
  })

  it("can process /cancel while an earlier agent update is still running", async () => {
    let finishSubmit: ((value: { kind: "completed"; text: string }) => void) | undefined
    const pendingSubmit = new Promise<{ kind: "completed"; text: string }>((resolve) => {
      finishSubmit = resolve
    })
    const sessions = createSessions({
      submit: vi.fn(async () => pendingSubmit),
      cancel: vi.fn(async () => true),
    })
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      { botInfo },
    )
    installApiMock(telegram.bot)

    const runningUpdate = telegram.bot.handleUpdate(privateMessage(4, "長任務"))
    await vi.waitFor(() => expect(sessions.submit).toHaveBeenCalledOnce())
    const cancelUpdate = privateMessage(5, "/cancel")
    if (cancelUpdate.message) {
      cancelUpdate.message.entities = [{ offset: 0, length: 7, type: "bot_command" }]
    }
    await telegram.bot.handleUpdate(cancelUpdate)

    expect(sessions.cancel).toHaveBeenCalledWith(7)
    finishSubmit?.({ kind: "completed", text: "已完成" })
    await runningUpdate
  })

  it("preserves per-chat submission order while an earlier image downloads", async () => {
    let finishImageDownload: ((response: Response) => void) | undefined
    const pendingImageDownload = new Promise<Response>((resolve) => {
      finishImageDownload = resolve
    })
    let finishFirstSubmission: ((value: { kind: "completed"; text: string }) => void) | undefined
    const pendingFirstSubmission = new Promise<{ kind: "completed"; text: string }>((resolve) => {
      finishFirstSubmission = resolve
    })
    const submissionOrder: string[] = []
    const sessions = createSessions({
      submit: vi.fn(async (_chatId, prompt, options) => {
        submissionOrder.push(prompt)
        options.onAccepted?.()
        return prompt === "第一張"
          ? pendingFirstSubmission
          : { kind: "completed" as const, text: "AI 回覆" }
      }),
    })
    const imageFetchImplementation = vi.fn<typeof fetch>(async () => pendingImageDownload)
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      {
        botInfo,
        imageFetchImplementation,
      },
    )
    installApiMock(telegram.bot)
    const photoUpdate = privateMessage(6, "")
    if (photoUpdate.message) {
      photoUpdate.message.photo = [
        {
          file_id: "image",
          file_unique_id: "image-unique-id",
          width: 100,
          height: 100,
          file_size: 5,
        },
      ]
      photoUpdate.message.caption = "第一張"
      delete photoUpdate.message.text
    }

    const firstHandling = telegram.bot.handleUpdate(photoUpdate)
    await vi.waitFor(() => expect(imageFetchImplementation).toHaveBeenCalledOnce())
    const secondHandling = telegram.bot.handleUpdate(privateMessage(7, "第二則"))
    await Promise.resolve()
    expect(sessions.submit).not.toHaveBeenCalled()

    finishImageDownload?.(new Response("image"))
    await vi.waitFor(() => expect(sessions.submit).toHaveBeenCalledTimes(2))
    await secondHandling
    expect(submissionOrder).toEqual(["第一張", "第二則"])

    finishFirstSubmission?.({ kind: "completed", text: "第一則完成" })
    await firstHandling
  })

  it("invalidates queued pre-reset work without blocking post-reset submissions", async () => {
    let finishImageDownload: ((response: Response) => void) | undefined
    const pendingImageDownload = new Promise<Response>((resolve) => {
      finishImageDownload = resolve
    })
    const submittedPrompts: string[] = []
    const sessions = createSessions({
      submit: vi.fn(async (_chatId, prompt, options) => {
        submittedPrompts.push(prompt)
        options.onAccepted?.()
        return { kind: "completed" as const, text: "AI 回覆" }
      }),
    })
    const imageFetchImplementation = vi.fn<typeof fetch>(async () => pendingImageDownload)
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      {
        botInfo,
        imageFetchImplementation,
      },
    )
    installApiMock(telegram.bot)
    const photoUpdate = privateMessage(8, "")
    if (photoUpdate.message) {
      photoUpdate.message.photo = [
        {
          file_id: "image",
          file_unique_id: "image-unique-id",
          width: 100,
          height: 100,
          file_size: 5,
        },
      ]
      photoUpdate.message.caption = "重設前圖片"
      delete photoUpdate.message.text
    }

    const imageHandling = telegram.bot.handleUpdate(photoUpdate)
    await vi.waitFor(() => expect(imageFetchImplementation).toHaveBeenCalledOnce())
    const queuedHandling = telegram.bot.handleUpdate(privateMessage(9, "重設前排隊訊息"))
    await new Promise<void>((resolve) => setImmediate(resolve))
    const resetUpdate = privateMessage(10, "/reset")
    if (resetUpdate.message) {
      resetUpdate.message.entities = [{ offset: 0, length: 6, type: "bot_command" }]
    }
    await telegram.bot.handleUpdate(resetUpdate)
    await telegram.bot.handleUpdate(privateMessage(11, "重設後"))

    expect(sessions.reset).toHaveBeenCalledWith(7)
    expect(submittedPrompts).toEqual(["重設後"])

    finishImageDownload?.(new Response("image"))
    await Promise.all([imageHandling, queuedHandling])
    expect(submittedPrompts).toEqual(["重設後"])
  })

  it("sends a cancellation reply when reset invalidates a completed submission", async () => {
    let finishSubmission: ((value: { kind: "completed"; text: string }) => void) | undefined
    const pendingSubmission = new Promise<{ kind: "completed"; text: string }>((resolve) => {
      finishSubmission = resolve
    })
    const sessions = createSessions({
      submit: vi.fn(async (_chatId, _prompt, options) => {
        options.onAccepted?.()
        return pendingSubmission
      }),
    })
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      { botInfo },
    )
    const calls = installApiMock(telegram.bot)

    const runningUpdate = telegram.bot.handleUpdate(privateMessage(12, "長任務"))
    await vi.waitFor(() => expect(sessions.submit).toHaveBeenCalledOnce())
    const resetUpdate = privateMessage(13, "/reset")
    if (resetUpdate.message) {
      resetUpdate.message.entities = [{ offset: 0, length: 6, type: "bot_command" }]
    }
    await telegram.bot.handleUpdate(resetUpdate)

    finishSubmission?.({ kind: "completed", text: "過期回覆" })
    await runningUpdate
    expect(calls.map((call) => call.method)).toEqual(["sendMessage", "sendMessage"])
    expect(calls[1]?.payload.text).toBe("此請求已因重設對話而取消。")
  })

  it("does not publish a stale Morsel reply after reset", async () => {
    let finishPublication: ((value: string) => void) | undefined
    const pendingPublication = new Promise<string>((resolve) => {
      finishPublication = resolve
    })
    const sessions = createSessions({
      submit: vi.fn(async (_chatId, _prompt, options) => {
        options.onAccepted?.()
        return { kind: "completed" as const, text: "長".repeat(1_001) }
      }),
    })
    const publish = vi.fn(async () => pendingPublication)
    const settings = loadSettings({ BOT_TOKEN: "test-token", MORSEL_API_KEY: "secret" })
    const telegram = createTelegramAgentBot(settings, sessions, logger, {
      botInfo,
      morselPublisher: { isConfigured: true, publish },
    })
    const calls = installApiMock(telegram.bot)

    const runningUpdate = telegram.bot.handleUpdate(privateMessage(12, "請回答"))
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce())
    const resetUpdate = privateMessage(13, "/reset")
    if (resetUpdate.message) {
      resetUpdate.message.entities = [{ offset: 0, length: 6, type: "bot_command" }]
    }
    await telegram.bot.handleUpdate(resetUpdate)

    finishPublication?.("https://morsel.example/s/share")
    await runningUpdate
    expect(calls.map((call) => call.method)).toEqual(["sendMessage", "sendMessage"])
    expect(calls[1]?.payload.text).toBe("此請求已因重設對話而取消。")
  })

  it("sends a cancellation reply when an invalidated submission fails", async () => {
    let failSubmission: ((reason: Error) => void) | undefined
    const pendingSubmission = new Promise<never>((_resolve, reject) => {
      failSubmission = reject
    })
    const sessions = createSessions({
      submit: vi.fn(async () => pendingSubmission),
    })
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      { botInfo },
    )
    const calls = installApiMock(telegram.bot)

    const runningUpdate = telegram.bot.handleUpdate(privateMessage(14, "長任務"))
    await vi.waitFor(() => expect(sessions.submit).toHaveBeenCalledOnce())
    const resetUpdate = privateMessage(15, "/reset")
    if (resetUpdate.message) {
      resetUpdate.message.entities = [{ offset: 0, length: 6, type: "bot_command" }]
    }
    await telegram.bot.handleUpdate(resetUpdate)

    failSubmission?.(new Error("Pi session access was invalidated by reset"))
    await runningUpdate
    expect(calls.map((call) => call.method)).toEqual(["sendMessage", "sendMessage"])
    expect(calls[1]?.payload.text).toBe("此請求已因重設對話而取消。")
  })

  it("replaces a stale Morsel link when reset interrupts Telegram delivery", async () => {
    let finishDelivery = () => {}
    const pendingDelivery = new Promise<void>((resolve) => {
      finishDelivery = resolve
    })
    const shareUrl = "https://morsel.example/s/share"
    const publish = vi.fn(async () => shareUrl)
    const sessions = createSessions({
      submit: vi.fn(async (_chatId, _prompt, options) => {
        options.onAccepted?.()
        return { kind: "completed" as const, text: "x".repeat(5_000) }
      }),
    })
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      {
        botInfo,
        morselPublisher: { isConfigured: true, publish },
      },
    )
    const calls = installApiMock(telegram.bot, async (method, payload) => {
      if (method === "sendMessage" && String(payload.text).includes(shareUrl)) {
        await pendingDelivery
      }
    })
    const runningUpdate = telegram.bot.handleUpdate(privateMessage(16, "長回覆"))
    try {
      await vi.waitFor(() =>
        expect(calls.some((call) => String(call.payload.text).includes(shareUrl))).toBe(true),
      )
      await telegram.bot.handleUpdate(commandMessage(17, "/reset"))
    } finally {
      finishDelivery()
      await runningUpdate
    }
    expect(calls.map((call) => call.method)).toEqual([
      "sendMessage",
      "sendMessage",
      "editMessageText",
    ])
    expect(calls.at(-1)?.payload.text).toBe("此請求已因重設對話而取消。")
    expect(sessions.recordDelivery).not.toHaveBeenCalled()
  })

  it("does not record a Morsel answer when Telegram rejects its link", async () => {
    const shareUrl = "https://morsel.example/s/share"
    const sessions = createSessions({
      submit: vi.fn(async () => ({
        kind: "completed" as const,
        text: "x".repeat(5_000),
        checkpoint: { sessionId: "session", entryId: "entry", generation: 0 },
      })),
    })
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      {
        botInfo,
        morselPublisher: { isConfigured: true, publish: vi.fn(async () => shareUrl) },
      },
    )
    const calls = installApiMock(telegram.bot, (method, payload) => {
      if (method === "sendMessage" && String(payload.text).includes(shareUrl)) {
        throw new Error("Telegram reply failed")
      }
    })
    await telegram.bot.handleUpdate(privateMessage(18, "長回覆"))
    expect(sessions.recordDelivery).not.toHaveBeenCalled()
    expect(calls.map((call) => call.method)).toEqual(["sendMessage", "sendMessage"])
    expect(calls.at(-1)?.payload.text).toBe("AI 服務暫時無法使用，請稍後再試。")
  })

  it("orders passive group context after an earlier addressed image submission", async () => {
    let finishImageDownload: ((response: Response) => void) | undefined
    const pendingImageDownload = new Promise<Response>((resolve) => {
      finishImageDownload = resolve
    })
    const events: string[] = []
    const sessions = createSessions({
      submit: vi.fn(async (_chatId, _prompt, options) => {
        events.push("submit")
        options.onAccepted?.()
        return { kind: "completed" as const, text: "AI 回覆" }
      }),
      appendPassiveContext: vi.fn(async () => {
        events.push("passive")
      }),
    })
    const imageFetchImplementation = vi.fn<typeof fetch>(async () => pendingImageDownload)
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      {
        botInfo,
        imageFetchImplementation,
      },
    )
    installApiMock(telegram.bot)
    const addressedUpdate: Update = {
      update_id: 12,
      message: {
        message_id: 12,
        date: 1_700_000_000,
        chat: { id: -100, type: "supergroup", title: "測試群組" },
        from: { id: 7, is_bot: false, first_name: "Alice" },
        photo: [
          {
            file_id: "image",
            file_unique_id: "image-unique-id",
            width: 100,
            height: 100,
            file_size: 5,
          },
        ],
        caption: "@test_bot 請看圖",
      },
    }
    const passiveUpdate: Update = {
      update_id: 13,
      message: {
        message_id: 13,
        date: 1_700_000_001,
        chat: { id: -100, type: "supergroup", title: "測試群組" },
        from: { id: 8, is_bot: false, first_name: "Bob" },
        text: "後續群組訊息",
      },
    }

    const addressedHandling = telegram.bot.handleUpdate(addressedUpdate)
    await vi.waitFor(() => expect(imageFetchImplementation).toHaveBeenCalledOnce())
    const passiveHandling = telegram.bot.handleUpdate(passiveUpdate)
    await Promise.resolve()
    expect(events).toEqual([])

    finishImageDownload?.(new Response("image"))
    await Promise.all([addressedHandling, passiveHandling])
    expect(events).toEqual(["submit", "passive"])
  })

  it("reports oversized image errors without invoking the agent", async () => {
    const sessions = createSessions()
    const settings = {
      ...loadSettings({ BOT_TOKEN: "test-token" }),
      botImageMaxBytes: 10,
    }
    const telegram = createTelegramAgentBot(settings, sessions, logger, { botInfo })
    const calls = installApiMock(telegram.bot)
    const update = privateMessage(6, "看圖")
    if (update.message) {
      update.message.photo = [
        { file_id: "large", file_unique_id: "large", width: 100, height: 100, file_size: 11 },
      ]
    }

    await telegram.bot.handleUpdate(update)

    expect(sessions.submit).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload.text).toBe("圖片超過允許的大小，無法處理。")
  })

  it.each(["disabled", "rich_only", "smart"] as const)(
    "forces Morsel above 1000 characters in %s mode despite a higher legacy threshold",
    async (mode) => {
      const text = "長".repeat(1_001)
      const sessions = createSessions({
        submit: vi.fn(async () => ({ kind: "completed" as const, text })),
      })
      const publish = vi.fn(async () => "https://morsel.example/s/share")
      const settings = {
        ...loadSettings({ BOT_TOKEN: "test-token" }),
        morselMode: mode,
        morselLongReplyThreshold: 5_000,
      }
      const telegram = createTelegramAgentBot(settings, sessions, logger, {
        botInfo,
        morselPublisher: { isConfigured: true, publish },
      })
      const calls = installApiMock(telegram.bot)
      await telegram.bot.handleUpdate(privateMessage(7, "請回答"))
      expect(publish).toHaveBeenCalledExactlyOnceWith(text)
      expect(calls[0]?.payload.text).toContain("https://morsel.example/s/share")
      expect(calls.map((call) => call.method)).toEqual(["sendMessage"])
    },
  )

  it.each(["missing-key", "publish-failed"])(
    "never sends long answers or records delivery when Morsel has %s",
    async (failure) => {
      const text = "長".repeat(10_000)
      const sessions = createSessions({
        submit: vi.fn(async () => ({
          kind: "completed" as const,
          text,
          checkpoint: { sessionId: "session", entryId: "entry", generation: 0 },
        })),
      })
      const publish = vi.fn(async () => {
        throw new Error("Morsel unavailable")
      })
      const telegram = createTelegramAgentBot(
        loadSettings({ BOT_TOKEN: "test-token" }),
        sessions,
        logger,
        {
          botInfo,
          morselPublisher: { isConfigured: failure !== "missing-key", publish },
        },
      )
      const calls = installApiMock(telegram.bot)
      await telegram.bot.handleUpdate(privateMessage(80, "長答案"))
      expect(calls.map((call) => call.method)).toEqual(["sendMessage"])
      const expectedReason =
        failure === "missing-key" ? "MORSEL_API_KEY is not configured" : "Morsel unavailable"
      expect(calls.at(-1)?.payload.text).toContain(`Morsel 暫時無法使用（原因：${expectedReason}）`)
      expect(calls.some((call) => String(call.payload.text).includes("長長長"))).toBe(false)
      expect(sessions.recordDelivery).not.toHaveBeenCalled()
      expect(publish).toHaveBeenCalledTimes(failure === "missing-key" ? 0 : 1)
    },
  )

  it("publishes long market-data replies once instead of chunking them into Telegram", async () => {
    const text = "股".repeat(5_000)
    const sessions = createSessions()
    const publish = vi.fn(async () => "https://morsel.example/s/share")
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      {
        botInfo,
        marketDataQuery: async () => text,
        morselPublisher: { isConfigured: true, publish },
      },
    )
    const calls = installApiMock(telegram.bot)
    await telegram.bot.handleUpdate(commandMessage(81, "/t AAPL"))
    expect(publish).toHaveBeenCalledExactlyOnceWith(text)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload.text).toContain("https://morsel.example/s/share")
    expect(calls[0]?.payload.reply_parameters).toEqual({ message_id: 81 })
    expect(sessions.submit).not.toHaveBeenCalled()
  })

  it("applies the same Morsel policy to long progress replies", async () => {
    const sessions = createSessions({
      submit: vi.fn(async (_chatId, _prompt, options) => {
        options.onAccepted?.()
        options.onProgress?.(
          Array.from({ length: 6 }, (_, index) => ({
            text: "工作".repeat(120),
            status: index === 0 ? ("in_progress" as const) : ("pending" as const),
          })),
        )
        return { kind: "completed" as const, text: "完成" }
      }),
    })
    const publish = vi.fn(async () => "https://morsel.example/s/progress")
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      {
        botInfo,
        morselPublisher: { isConfigured: true, publish },
      },
    )
    const calls = installApiMock(telegram.bot)
    await telegram.bot.handleUpdate(privateMessage(82, "長任務"))
    expect(publish).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("進度 0/6"))
    expect(calls.map((call) => call.method)).toEqual(["sendMessage", "editMessageText"])
    expect(calls[0]?.payload.text).toContain("https://morsel.example/s/progress")
    expect(calls[1]?.payload.text).toBe("完成")
  })

  it.each(["private", "group", "bot-reply"])(
    "converts replied documents for /ask in %s context",
    async (kind) => {
      const sessions = createSessions()
      const run = vi.fn(async () => ({
        ok: true as const,
        markdown: "# Converted document",
        format: "csv",
        originalChars: 20,
        truncated: false,
      }))
      const telegram = createTelegramAgentBot(
        loadSettings({ BOT_TOKEN: "test-token" }),
        sessions,
        logger,
        {
          botInfo,
          documentConverter: AnyDocConverter.forTesting({
            maxConcurrency: 1,
            maxMarkdownChars: 100,
            timeoutMs: 1_000,
            run,
          }),
          imageFetchImplementation: vi.fn(async () => new Response("bytes")),
        },
      )
      installApiMock(telegram.bot)
      const update = repliedDocumentCommand(400, "/ask@test_bot 請摘要")
      const message = update.message
      if (message?.reply_to_message) {
        if (kind === "group") {
          message.chat = { id: -100, type: "supergroup", title: "Group" }
          message.reply_to_message.chat = message.chat
        }
        if (kind === "bot-reply") message.reply_to_message.from = botInfo
      }
      await telegram.bot.handleUpdate(update)

      expect(run).toHaveBeenCalledExactlyOnceWith(Buffer.from("bytes"), "report.csv", 100, 1_000)
      expect(sessions.submit).toHaveBeenCalledOnce()
      const [chatId, prompt, options] = vi.mocked(sessions.submit).mock.calls[0] ?? []
      expect(chatId).toBe(kind === "group" ? -100 : 7)
      expect(prompt).toContain("請摘要")
      expect(prompt).toContain("# Converted document")
      expect(prompt).toContain('trust="untrusted"')
      expect(prompt).not.toContain("/ask")
      expect(options?.images).toEqual([])
      expect(options?.replyToBotMessageId).toBe(kind === "bot-reply" ? 50 : undefined)
    },
  )

  it.each([
    ["disabled", "目前未啟用文件輸入。"],
    ["unavailable", "文件轉換服務目前無法使用。"],
    ["oversized", "文件超過允許的大小，無法處理。"],
    ["conversion", "這份 PDF 需要 OCR，目前只支援含可擷取文字的 PDF。"],
  ])("reports /ask document %s failures without invoking Pi", async (failure, expected) => {
    const sessions = createSessions()
    const fetchDocument = vi.fn(async () => new Response("bytes"))
    const run = vi.fn(async () => ({ ok: false as const, code: "needsOcr", message: "OCR needed" }))
    const telegram = createTelegramAgentBot(
      loadSettings({
        BOT_TOKEN: "test-token",
        BOT_DOCUMENT_INPUT_ENABLED: failure === "disabled" ? "false" : "true",
        BOT_DOCUMENT_MAX_BYTES: failure === "oversized" ? "4" : "100",
      }),
      sessions,
      logger,
      {
        botInfo,
        imageFetchImplementation: fetchDocument,
        documentConverter:
          failure === "unavailable"
            ? undefined
            : AnyDocConverter.forTesting({
                maxConcurrency: 1,
                maxMarkdownChars: 100,
                timeoutMs: 1_000,
                run,
              }),
      },
    )
    const calls = installApiMock(telegram.bot)
    await telegram.bot.handleUpdate(repliedDocumentCommand(401))

    expect(sessions.submit).not.toHaveBeenCalled()
    expect(calls.at(-1)?.payload.text).toBe(expected)
    expect(run).toHaveBeenCalledTimes(failure === "conversion" ? 1 : 0)
    expect(fetchDocument).toHaveBeenCalledTimes(failure === "conversion" ? 1 : 0)
  })

  it("preserves /ask usage when no question is provided", async () => {
    const sessions = createSessions()
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      { botInfo },
    )
    const calls = installApiMock(telegram.bot)
    await telegram.bot.handleUpdate(repliedDocumentCommand(402, "/ask"))
    expect(sessions.submit).not.toHaveBeenCalled()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.payload.text).toBe("請使用 /ask <問題>。")
  })

  it("converts current and replied documents with captions and a captionless default", async () => {
    const sessions = createSessions()
    const documentConverter = {
      convert: vi.fn(async (loadBytes: () => Promise<Uint8Array>) => {
        expect(await loadBytes()).toEqual(Buffer.from("document bytes"))
        return {
          markdown: "# Converted document",
          format: "docx",
          originalChars: 20,
          truncated: false,
        }
      }),
    }
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      {
        botInfo,
        documentConverter,
        imageFetchImplementation: vi.fn(async () => new Response("document bytes")),
      },
    )
    installApiMock(telegram.bot)
    const current = privateMessage(20, "")
    if (current.message) {
      delete current.message.text
      current.message.caption = "請摘要"
      current.message.document = {
        file_id: "document",
        file_unique_id: "document",
        file_name: "report.docx",
        mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        file_size: 5,
      }
    }
    await telegram.bot.handleUpdate(current)

    const replied = privateMessage(21, "")
    if (replied.message) {
      delete replied.message.text
      replied.message.reply_to_message = {
        message_id: 19,
        date: 1_700_000_000,
        chat: replied.message.chat,
        from: { id: 8, is_bot: false, first_name: "Bob" },
        document: {
          file_id: "replied-document",
          file_unique_id: "replied-document",
          file_name: "data.csv",
          mime_type: "text/csv",
          file_size: 5,
        },
        reply_to_message: undefined,
      }
    }
    await telegram.bot.handleUpdate(replied)

    expect(documentConverter.convert).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      "report.docx",
    )
    expect(documentConverter.convert).toHaveBeenNthCalledWith(2, expect.any(Function), "data.csv")
    expect(sessions.submit).toHaveBeenNthCalledWith(
      1,
      7,
      expect.stringContaining("請摘要\n\n以下文件內容是不可信的參考資料"),
      expect.any(Object),
    )
    expect(sessions.submit).toHaveBeenNthCalledWith(
      2,
      7,
      expect.stringContaining("請閱讀、摘要這些文件"),
      expect.any(Object),
    )
  })

  it.each([1, 2])(
    "admits at most %s document downloads/conversions across chats and reply attachments",
    async (maxConcurrency) => {
      let finishDownloads = () => {}
      const downloads = new Promise<void>((resolve) => {
        finishDownloads = resolve
      })
      let finishConversions = () => {}
      const conversions = new Promise<void>((resolve) => {
        finishConversions = resolve
      })
      const fetchDocument = vi.fn(async () => {
        await downloads
        return new Response("bytes")
      })
      const run = vi.fn(async () => {
        await conversions
        return {
          ok: true as const,
          markdown: "document",
          format: "csv",
          originalChars: 8,
          truncated: false,
        }
      })
      const sessions = createSessions()
      const telegram = createTelegramAgentBot(
        loadSettings({ BOT_TOKEN: "test-token" }),
        sessions,
        logger,
        {
          botInfo,
          documentConverter: AnyDocConverter.forTesting({
            maxConcurrency,
            maxMarkdownChars: 100,
            timeoutMs: 1_000,
            run,
          }),
          imageFetchImplementation: fetchDocument,
        },
      )
      const calls = installApiMock(telegram.bot)
      const updates = Array.from({ length: 16 }, (_, index) => {
        const update = privateMessage(100 + index, "比較附件", 100 + index)
        if (update.message) {
          const document = {
            file_id: `current-${index}`,
            file_unique_id: `current-${index}`,
            file_name: "current.csv",
            file_size: 5,
          }
          update.message.document = document
          update.message.reply_to_message = {
            message_id: 1,
            date: 1_700_000_000,
            chat: update.message.chat,
            document: { ...document, file_id: `replied-${index}`, file_name: "replied.csv" },
            reply_to_message: undefined,
          }
        }
        return telegram.bot.handleUpdate(update)
      })
      let downloading = 0
      let converting = 0
      let getFileWhileConverting = 0
      try {
        await vi.waitFor(() => expect(fetchDocument).toHaveBeenCalled())
        await new Promise<void>((resolve) => setImmediate(resolve))
        downloading = fetchDocument.mock.calls.length
        expect(run).not.toHaveBeenCalled()
        // Waiting document jobs must not block an unrelated text-only request.
        await telegram.bot.handleUpdate(privateMessage(200, "文字請求", 200))
        expect(sessions.submit).toHaveBeenCalledOnce()
        finishDownloads()
        await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(maxConcurrency))
        await new Promise<void>((resolve) => setImmediate(resolve))
        converting = fetchDocument.mock.calls.length
        getFileWhileConverting = calls.filter((call) => call.method === "getFile").length
      } finally {
        finishDownloads()
        finishConversions()
        await Promise.all(updates)
      }

      expect(downloading).toBe(maxConcurrency)
      expect(converting).toBe(maxConcurrency)
      expect(getFileWhileConverting).toBe(maxConcurrency)
      expect(fetchDocument).toHaveBeenCalledTimes(32)
      expect(run).toHaveBeenCalledTimes(32)
      expect(sessions.submit).toHaveBeenCalledTimes(17)
    },
  )

  it("handles image and document input together and reports bounded document failures", async () => {
    const sessions = createSessions()
    const documentConverter = {
      convert: vi.fn(async (loadBytes: () => Promise<Uint8Array>) => {
        await loadBytes()
        return {
          markdown: "document",
          format: "pdf",
          originalChars: 8,
          truncated: false,
        }
      }),
    }
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      {
        botInfo,
        documentConverter,
        imageFetchImplementation: vi.fn(async () => new Response("bytes")),
      },
    )
    installApiMock(telegram.bot)
    const update = privateMessage(22, "分析附件")
    if (update.message) {
      update.message.photo = [
        { file_id: "image", file_unique_id: "image", width: 100, height: 100, file_size: 5 },
      ]
      update.message.document = {
        file_id: "document",
        file_unique_id: "document",
        file_name: "report.pdf",
        mime_type: "application/pdf",
        file_size: 5,
      }
    }
    await telegram.bot.handleUpdate(update)
    expect(sessions.submit).toHaveBeenCalledWith(
      7,
      expect.stringContaining("Filename: report.pdf"),
      expect.objectContaining({ images: [expect.objectContaining({ type: "image" })] }),
    )

    const failingSessions = createSessions()
    const failing = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      failingSessions,
      logger,
      {
        botInfo,
        documentConverter: {
          convert: vi.fn(async () => {
            throw new DocumentConversionError("needsOcr", "pages 1")
          }),
        },
        imageFetchImplementation: vi.fn(async () => new Response("bytes")),
      },
    )
    const calls = installApiMock(failing.bot)
    await failing.bot.handleUpdate(update)
    expect(failingSessions.submit).not.toHaveBeenCalled()
    expect(calls.at(-1)?.payload.text).toContain("需要 OCR")
  })

  it.each([
    ["unsupported", "目前不支援這種文件格式。"],
    ["encrypted", "這份文件有密碼或已加密，無法讀取。"],
    ["malformed", "文件內容損毀或缺少必要部分，無法讀取。"],
    ["missingPart", "文件內容損毀或缺少必要部分，無法讀取。"],
    ["resourceLimit", "文件內容過於複雜，已基於安全限制停止轉換。"],
    ["timeout", "文件轉換逾時，請改用較小或較簡單的文件。"],
    ["empty", "文件沒有可讀取的內容。"],
  ] as const)("reports a direct Traditional Chinese %s document error", async (kind, expected) => {
    const sessions = createSessions()
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      {
        botInfo,
        documentConverter: {
          convert: vi.fn(async () => {
            throw new DocumentConversionError(kind, kind)
          }),
        },
        imageFetchImplementation: vi.fn(async () => new Response("bytes")),
      },
    )
    const calls = installApiMock(telegram.bot)
    const update = privateMessage(40, "")
    if (update.message) {
      delete update.message.text
      update.message.document = {
        file_id: "document",
        file_unique_id: "document",
        file_name: "report.bin",
        file_size: 5,
      }
    }

    await telegram.bot.handleUpdate(update)

    expect(sessions.submit).not.toHaveBeenCalled()
    expect(calls.find((call) => call.method === "sendMessage")?.payload.text).toBe(expected)
  })

  it("rejects disabled and oversized documents before native conversion", async () => {
    const sessions = createSessions()
    const run = vi.fn()
    const documentConverter = AnyDocConverter.forTesting({
      maxConcurrency: 1,
      maxMarkdownChars: 100,
      timeoutMs: 1_000,
      run,
    })
    const disabled = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token", BOT_DOCUMENT_INPUT_ENABLED: "false" }),
      sessions,
      logger,
      { botInfo, documentConverter },
    )
    const disabledCalls = installApiMock(disabled.bot)
    const update = privateMessage(23, "")
    if (update.message) {
      delete update.message.text
      update.message.document = {
        file_id: "document",
        file_unique_id: "document",
        file_name: "report.docx",
        file_size: 21,
      }
    }
    await disabled.bot.handleUpdate(update)
    expect(disabledCalls[0]?.payload.text).toBe("目前未啟用文件輸入。")

    const oversized = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token", BOT_DOCUMENT_MAX_BYTES: "20" }),
      sessions,
      logger,
      { botInfo, documentConverter },
    )
    const oversizedCalls = installApiMock(oversized.bot)
    await oversized.bot.handleUpdate(update)
    expect(oversizedCalls[0]?.payload.text).toBe("文件超過允許的大小，無法處理。")
    expect(run).not.toHaveBeenCalled()
    expect(sessions.submit).not.toHaveBeenCalled()
  })

  it.each(
    (["message", "ask"] as const).flatMap((input) =>
      (
        [
          ["queued", false],
          ["download", false],
          ["conversion", false],
          ["download", true],
          ["conversion", true],
        ] as const
      ).map(([stage, failure]) => ({ input, stage, failure })),
    ),
  )(
    "cancels $input document work during $stage (failure=$failure)",
    async ({ input, stage, failure }) => {
      let releaseWork = () => {}
      const pendingWork = new Promise<void>((resolve) => {
        releaseWork = resolve
      })
      const fetchDocument = vi.fn(async () => {
        if (stage === "download") {
          await pendingWork
          if (failure) throw new Error("late download failure")
        }
        return new Response("bytes")
      })
      const run = vi.fn(async () => {
        if (stage !== "download") {
          await pendingWork
          if (failure) throw new Error("late conversion failure")
        }
        return {
          ok: true as const,
          markdown: "document",
          format: "csv",
          originalChars: 8,
          truncated: false,
        }
      })
      const converter = AnyDocConverter.forTesting({
        maxConcurrency: 1,
        maxMarkdownChars: 100,
        timeoutMs: 1_000,
        run,
      })
      const convert = vi.spyOn(converter, "convert")
      const occupying =
        stage === "queued"
          ? converter.convert(async () => Buffer.from("busy"), "busy.csv")
          : undefined
      if (occupying) await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
      const sessions = createSessions()
      const telegram = createTelegramAgentBot(
        loadSettings({ BOT_TOKEN: "test-token" }),
        sessions,
        logger,
        { botInfo, documentConverter: converter, imageFetchImplementation: fetchDocument },
      )
      const calls = installApiMock(telegram.bot)
      const document = input === "ask" ? repliedDocumentCommand(300) : privateMessage(300, "")
      if (input === "message" && document.message) {
        delete document.message.text
        document.message.document = {
          file_id: "document",
          file_unique_id: "document",
          file_name: "report.csv",
          file_size: 5,
        }
      }
      const handling = telegram.bot.handleUpdate(document)
      let fresh: Promise<void> | undefined
      let acceptedWhileDraining = 0
      try {
        await vi.waitFor(() => {
          if (stage === "queued") expect(convert).toHaveBeenCalledTimes(2)
          else if (stage === "download") expect(fetchDocument).toHaveBeenCalledOnce()
          else expect(run).toHaveBeenCalledOnce()
        })
        await telegram.bot.handleUpdate(commandMessage(301, "/cancel"))
        fresh = telegram.bot.handleUpdate(privateMessage(302, "fresh"))
        await new Promise<void>((resolve) => setImmediate(resolve))
        acceptedWhileDraining = vi.mocked(sessions.submit).mock.calls.length
      } finally {
        releaseWork()
        await Promise.all([handling, occupying, fresh])
      }

      expect(sessions.cancel).toHaveBeenCalledWith(7)
      expect(sessions.reset).not.toHaveBeenCalled()
      expect(acceptedWhileDraining).toBe(1)
      expect(sessions.submit).toHaveBeenCalledExactlyOnceWith(7, "fresh", expect.any(Object))
      expect(
        calls.filter((call) => call.method === "sendMessage").map((call) => call.payload.text),
      ).toEqual(["已取消目前任務。", "AI 回覆"])
      expect(fetchDocument).toHaveBeenCalledTimes(stage === "queued" ? 0 : 1)
      expect(run).toHaveBeenCalledTimes(stage === "download" ? 0 : 1)
    },
  )

  it("cancels before agent acceptance without labelling it as a reset", async () => {
    let acceptSubmission = () => {}
    const pendingAcceptance = new Promise<void>((resolve) => {
      acceptSubmission = resolve
    })
    const sessions = createSessions({
      submit: vi.fn(async (_chatId, _prompt, options) => {
        await pendingAcceptance
        if (options.isCurrent?.() === false) {
          throw new Error("Pi session submission was cancelled before acceptance")
        }
        options.onAccepted?.()
        return { kind: "completed" as const, text: "過期回覆" }
      }),
    })
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      { botInfo },
    )
    const calls = installApiMock(telegram.bot)
    const handling = telegram.bot.handleUpdate(privateMessage(304, "request"))
    try {
      await vi.waitFor(() => expect(sessions.submit).toHaveBeenCalledOnce())
      await telegram.bot.handleUpdate(commandMessage(305, "/cancel"))
    } finally {
      acceptSubmission()
      await handling
    }
    expect(calls.map((call) => call.payload.text)).toEqual(["已取消目前任務。", "此請求已取消。"])
  })

  it("reports no task when cancelling an idle chat", async () => {
    const sessions = createSessions()
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      { botInfo },
    )
    const calls = installApiMock(telegram.bot)
    await telegram.bot.handleUpdate(commandMessage(303, "/cancel"))
    expect(calls[0]?.payload.text).toBe("目前沒有執行中的任務。")
  })

  it("does not submit a document conversion that finishes after reset", async () => {
    let finishConversion:
      | ((value: {
          markdown: string
          format: string
          originalChars: number
          truncated: boolean
        }) => void)
      | undefined
    const conversion = new Promise<{
      markdown: string
      format: string
      originalChars: number
      truncated: boolean
    }>((resolve) => {
      finishConversion = resolve
    })
    const sessions = createSessions()
    const convert = vi.fn(async () => conversion)
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      {
        botInfo,
        documentConverter: { convert },
        imageFetchImplementation: vi.fn(async () => new Response("bytes")),
      },
    )
    installApiMock(telegram.bot)
    const document = privateMessage(24, "")
    if (document.message) {
      delete document.message.text
      document.message.document = {
        file_id: "document",
        file_unique_id: "document",
        file_name: "report.docx",
        file_size: 5,
      }
    }
    const handling = telegram.bot.handleUpdate(document)
    await vi.waitFor(() => expect(convert).toHaveBeenCalledOnce())
    const reset = privateMessage(25, "/reset")
    if (reset.message) reset.message.entities = [{ offset: 0, length: 6, type: "bot_command" }]
    await telegram.bot.handleUpdate(reset)
    finishConversion?.({ markdown: "late", format: "docx", originalChars: 4, truncated: false })
    await handling
    expect(sessions.submit).not.toHaveBeenCalled()
  })

  it("passes mapped bot replies to the session and records the Morsel link message ID", async () => {
    const recordDelivery = vi.fn(async () => undefined)
    const sessions = createSessions({
      submit: vi.fn(async (_chatId, _prompt, options) => {
        options.onAccepted?.()
        return {
          kind: "completed" as const,
          text: "x".repeat(5_000),
          checkpoint: { sessionId: "session", entryId: "entry", generation: 0 },
        }
      }),
      recordDelivery,
    })
    const settings = {
      ...loadSettings({ BOT_TOKEN: "test-token" }),
      morselMode: "disabled" as const,
    }
    const telegram = createTelegramAgentBot(settings, sessions, logger, {
      botInfo,
      morselPublisher: {
        isConfigured: true,
        publish: vi.fn(async () => "https://morsel.example/s/share"),
      },
    })
    installApiMock(telegram.bot)
    const update = privateMessage(26, "另一個方向")
    if (update.message) {
      update.message.reply_to_message = {
        message_id: 50,
        date: 1_700_000_000,
        chat: update.message.chat,
        from: { id: botInfo.id, is_bot: true, first_name: "Test Bot" },
        text: "old answer",
        reply_to_message: undefined,
      }
    }
    await telegram.bot.handleUpdate(update)

    expect(sessions.submit).toHaveBeenCalledWith(
      7,
      "另一個方向",
      expect.objectContaining({
        replyToBotMessageId: 50,
        unresolvedReplyPrompt: expect.stringContaining("Content: old answer"),
      }),
    )
    expect(recordDelivery).toHaveBeenCalledWith(
      7,
      { sessionId: "session", entryId: "entry", generation: 0 },
      [100],
    )
  })

  it.each([
    "https://youtu.be/example",
    "https://en.wikipedia.org/wiki/Function_(mathematics)",
    "https://example.com/items[1]",
    "https://example.com/items{1}",
    "請摘要 https://example.com/article",
    "https://127.0.0.1/private",
    "go",
    "開始",
    "繼續",
    "抓抓看",
    "幫我抓",
    "摘要",
  ])("passes URL requests and short follow-ups to the agent unchanged: %s", async (text) => {
    const sessions = createSessions()
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      { botInfo },
    )
    const calls = installApiMock(telegram.bot)
    await telegram.bot.handleUpdate(privateMessage(27, text))

    expect(sessions.submit).toHaveBeenCalledExactlyOnceWith(7, text, expect.any(Object))
    expect(calls.map((call) => call.method)).toEqual(["sendMessage"])
    expect(calls.at(-1)?.payload.text).toBe("AI 回覆")
  })

  it("routes addressed group URLs and follow-ups after reset through the agent", async () => {
    const sessions = createSessions()
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      { botInfo },
    )
    installApiMock(telegram.bot)
    const url = "https://example.com/group"
    const message = {
      message_id: 32,
      date: 1_700_000_000,
      chat: { id: -100, type: "supergroup" as const, title: "測試群組" },
      from: { id: 7, is_bot: false, first_name: "Alice" },
      text: `@test_bot ${url}`,
    }
    await telegram.bot.handleUpdate({ update_id: 32, message })
    await telegram.bot.handleUpdate({
      update_id: 33,
      message: {
        ...message,
        message_id: 33,
        text: "/reset",
        entities: [{ offset: 0, length: 6, type: "bot_command" }],
      },
    })
    await telegram.bot.handleUpdate({
      update_id: 34,
      message: { ...message, message_id: 34, text: "@test_bot 繼續" },
    })

    expect(sessions.reset).toHaveBeenCalledWith(-100)
    expect(sessions.submit).toHaveBeenNthCalledWith(1, -100, url, expect.any(Object))
    expect(sessions.submit).toHaveBeenNthCalledWith(2, -100, "繼續", expect.any(Object))
  })

  it("keeps mixed questions and quoted historical URLs on the normal agent path", async () => {
    const sessions = createSessions()
    const telegram = createTelegramAgentBot(
      loadSettings({ BOT_TOKEN: "test-token" }),
      sessions,
      logger,
      { botInfo },
    )
    installApiMock(telegram.bot)
    const text = "這篇和昨天的有何不同 https://example.com/article"
    await telegram.bot.handleUpdate(privateMessage(29, text))
    const quoted = privateMessage(30, "你怎麼看？")
    if (quoted.message) {
      quoted.message.reply_to_message = {
        message_id: 60,
        date: 1_700_000_000,
        chat: quoted.message.chat,
        from: { id: botInfo.id, is_bot: true, first_name: "Test Bot" },
        text: "https://example.com/historical",
        reply_to_message: undefined,
      }
    }
    await telegram.bot.handleUpdate(quoted)

    expect(sessions.submit).toHaveBeenNthCalledWith(1, 7, text, expect.any(Object))
    expect(sessions.submit).toHaveBeenNthCalledWith(
      2,
      7,
      "你怎麼看？",
      expect.objectContaining({
        unresolvedReplyPrompt: expect.stringContaining("https://example.com/historical"),
      }),
    )
  })
})
