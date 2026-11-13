import type { PublicUrlLoader } from "@narumitw/sumire-pi-url-reader"
import type { Transformer } from "grammy"
import type { Message, Update, UserFromGetMe } from "grammy/types"
import { describe, expect, it, vi } from "vitest"
import type { ChatSessionRegistry } from "../src/agent/session-registry.js"
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

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

type Submit = ChatSessionRegistry["submit"]

function setup(
  options: {
    submit?: Submit
    articleUrlLoader?: PublicUrlLoader
    beforeResponse?: (method: string, payload: Record<string, unknown>) => Promise<void> | void
  } = {},
) {
  const pendingRefs: Array<{
    sourceMessageId: number
    statusMessageId?: number
    cleanup: ReturnType<typeof vi.fn>
  }> = []
  const submit = vi.fn<Submit>(
    options.submit ??
      (async (_chatId, _prompt, input = {}) => {
        input.onAccepted?.()
        return { kind: "completed", text: "Answer" }
      }),
  )
  const sessions = {
    submit,
    isPendingStatus: vi.fn(async () => false),
    trackPendingInput: vi.fn(
      (_chatId: number, sourceMessageId: number, statusMessageId?: number) => {
        const cleanup = vi.fn()
        pendingRefs.push({ sourceMessageId, statusMessageId, cleanup })
        return cleanup
      },
    ),
    recordDelivery: vi.fn(async () => undefined),
    holdReplyCheckpoint: vi.fn(() => () => undefined),
    appendPassiveContext: vi.fn(async () => undefined),
    cancel: vi.fn(async () => false),
    reset: vi.fn(async () => undefined),
  }
  const telegram = createTelegramAgentBot(
    loadSettings({ BOT_ADMIN_ID: "7", BOT_TOKEN: "test-token" }),
    sessions as unknown as ChatSessionRegistry,
    logger,
    {
      control: approvedStore([7, -100]),
      botInfo,
      articleUrlLoader: options.articleUrlLoader,
      morselPublisher: {
        isConfigured: true,
        publish: vi.fn(async () => "https://morsel.example/s/article"),
      },
    },
  )
  const deliveries: Array<{ method: string; payload: Record<string, unknown> }> = []
  let messageId = 100
  const transformer: Transformer = async (_previous, method, payload) => {
    const data = payload as Record<string, unknown>
    deliveries.push({ method, payload: data })
    const responseMessageId = method === "sendRichMessage" ? messageId++ : Number(data.message_id)
    await options.beforeResponse?.(method, data)
    return {
      ok: true,
      result: {
        message_id: responseMessageId,
        date: 1_700_000_000,
        chat: { id: Number(data.chat_id), type: "supergroup", title: "Group" },
        rich_message: {
          blocks: [{ type: "paragraph", text: telegramPayloadText(payload) ?? "" }],
        },
      },
    } as never
  }
  telegram.bot.api.config.use(transformer)
  return { ...telegram, sessions, pendingRefs, deliveries }
}

function submission(sessions: ReturnType<typeof setup>["sessions"], index = 0) {
  const call = sessions.submit.mock.calls[index]
  if (!call?.[2]) throw new Error(`Submission ${index} is missing`)
  return { prompt: call[1], input: call[2] }
}

function deferred<T = void>() {
  let resolve = (_value: T | PromiseLike<T>) => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function message(
  id: number,
  text: string,
  options: { privateChat?: boolean; reply?: { id: number; text: string; bot?: boolean } } = {},
): Update {
  const chat: Message["chat"] = options.privateChat
    ? { id: 7, type: "private", first_name: "Alice" }
    : { id: -100, type: "supergroup", title: "Group" }
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1_700_000_000,
      chat,
      from: { id: 7, is_bot: false, first_name: "Alice" },
      text,
      ...(text.startsWith("/")
        ? {
            entities: [
              { type: "bot_command" as const, offset: 0, length: text.split(" ")[0]?.length ?? 0 },
            ],
          }
        : {}),
      ...(options.reply
        ? {
            reply_to_message: {
              message_id: options.reply.id,
              date: 1_700_000_000,
              chat,
              from: options.reply.bot ? botInfo : { id: 8, is_bot: false, first_name: "Bob" },
              text: options.reply.text,
              reply_to_message: undefined,
            },
          }
        : {}),
    },
  }
}

function loaded(url = "https://example.com/article") {
  return {
    url,
    finalUrl: url,
    source: "built-in" as const,
    contentType: "text/plain",
    text: "Article source",
    truncated: false,
  }
}

describe("Telegram session routing", () => {
  it("bounds unknown pending-status correlation without using it as article source", async () => {
    const gate = deferred()
    let blocked = false
    const f = setup({
      beforeResponse: async (method, payload) => {
        if (
          method === "sendRichMessage" &&
          !blocked &&
          telegramPayloadText(payload) === "處理中…"
        ) {
          blocked = true
          await gate.promise
        }
      },
    })
    const first = f.bot.handleUpdate(message(1, "@test_bot first"))
    await vi.waitFor(() => expect(blocked).toBe(true))
    try {
      vi.useFakeTimers()
      const reply = f.bot.handleUpdate(
        message(2, "/f", { reply: { id: 100, text: "處理中…", bot: true } }),
      )
      await vi.advanceTimersByTimeAsync(2_001)
      await reply
      expect(f.sessions.submit).not.toHaveBeenCalled()
      expect(
        f.deliveries.some(({ payload }) =>
          telegramPayloadText(payload)?.includes("無法確認被回覆訊息的狀態"),
        ),
      ).toBe(true)
    } finally {
      vi.useRealTimers()
      gate.resolve()
      await first
    }
  })

  it.each([false, true])("isolates /f from reply restoration (private=%s)", async (privateChat) => {
    const { bot, sessions } = setup()
    await bot.handleUpdate(
      message(1, "/f", { privateChat, reply: { id: 40, text: "Article body", bot: true } }),
    )
    const { prompt, input } = submission(sessions)
    expect(prompt).toContain("Article body")
    expect(input).toMatchObject({
      routing: "article",
      intent: "newTurn",
      delivery: { sourceMessageId: 1, mode: "publish" },
    })
    expect(input).not.toHaveProperty("replyToBotMessageId")
    expect(input).not.toHaveProperty("replyToMessageId")
    expect(input).not.toHaveProperty("unresolvedReplyPrompt")
  })

  it.each([false, true])(
    "routes a group reply to any source message (bot=%s)",
    async (botSource) => {
      const { bot, sessions } = setup()
      await bot.handleUpdate(
        message(2, "@test_bot Explain", {
          reply: { id: 40, text: `Actual quote ${"x".repeat(10_000)}`, bot: botSource },
        }),
      )
      const { input } = submission(sessions)
      expect(input).toMatchObject({ routing: "reply", replyToMessageId: 40 })
      expect(input).not.toHaveProperty("replyToBotMessageId")
      expect(input.unresolvedReplyPrompt).toContain("Content: Actual quote")
      expect(input.unresolvedReplyPrompt?.length).toBeLessThan(6_000)
      expect(input.unresolvedReplyPrompt?.match(/Replied message context:/gu)).toHaveLength(1)
    },
  )

  it("keeps ordinary private reply routing unchanged", async () => {
    const { bot, sessions } = setup()
    await bot.handleUpdate(
      message(3, "Explain", {
        privateChat: true,
        reply: { id: 40, text: "Old answer", bot: true },
      }),
    )
    const { input } = submission(sessions)
    expect(input).toMatchObject({ replyToBotMessageId: 40 })
    expect(input).not.toHaveProperty("routing")
    expect(input).not.toHaveProperty("replyToMessageId")
  })

  it("does not block main or reply admission on slow article source loading", async () => {
    const source = deferred<ReturnType<typeof loaded>>()
    const load = vi.fn(() => source.promise)
    const { bot, sessions, pendingRefs } = setup({ articleUrlLoader: { load } })
    const article = bot.handleUpdate(message(10, "/f https://example.com/article"))
    try {
      await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
      expect(pendingRefs.filter((ref) => ref.sourceMessageId === 10)).toHaveLength(2)
      expect(pendingRefs.every((ref) => ref.cleanup.mock.calls.length === 0)).toBe(true)
      await bot.handleUpdate(message(11, "@test_bot Main question"))
      await bot.handleUpdate(
        message(12, "Explain", {
          reply: { id: 100, text: "正在載入文章來源… https://example.com/status", bot: true },
        }),
      )
      expect(sessions.submit.mock.calls.map((call) => call[2]?.routing)).toEqual(["main", "reply"])
      const reply = submission(sessions, 1)
      expect(reply.input).toMatchObject({ routing: "reply", replyToMessageId: 100 })
      expect(reply.prompt).not.toContain("正在載入")
      expect(reply.input.unresolvedReplyPrompt).not.toContain("https://example.com/status")
      expect(load).toHaveBeenCalledOnce()
      expect(
        pendingRefs
          .filter((ref) => ref.sourceMessageId === 10)
          .every((ref) => ref.cleanup.mock.calls.length === 0),
      ).toBe(true)
    } finally {
      source.resolve(loaded())
      await article
    }
    expect(submission(sessions, 2).input.routing).toBe("article")
    expect(pendingRefs.every((ref) => ref.cleanup.mock.calls.length === 1)).toBe(true)
  })

  it("correlates group replies while a pending status send is not yet acknowledged", async () => {
    const statusSent = deferred()
    const statusAcknowledged = deferred()
    const firstAnswer = deferred()
    const load = vi.fn(async () => loaded())
    let firstStatus = true
    const { bot, sessions } = setup({
      articleUrlLoader: { load },
      beforeResponse: async (method) => {
        if (method !== "sendRichMessage" || !firstStatus) return
        firstStatus = false
        statusSent.resolve()
        await statusAcknowledged.promise
      },
      submit: async (_chatId, _prompt, input = {}) => {
        input.onAccepted?.()
        if (input.delivery?.sourceMessageId === 60) await firstAnswer.promise
        return { kind: "completed", text: "Answer" }
      },
    })
    const first = bot.handleUpdate(message(60, "@test_bot First"))
    let reply: Promise<void> | undefined
    let article: Promise<void> | undefined
    try {
      await statusSent.promise
      const target = { id: 100, text: "處理中… https://example.com/status", bot: true }
      reply = bot.handleUpdate(message(61, "Explain", { reply: target }))
      article = bot.handleUpdate(message(62, "/f New source", { reply: target }))
      await bot.handleUpdate(
        message(63, "@test_bot Independent reply", {
          reply: { id: 40, text: "Known user source" },
        }),
      )
      expect(sessions.submit).toHaveBeenCalledOnce()
      statusAcknowledged.resolve()
      await Promise.all([reply, article])
      const replyInput = sessions.submit.mock.calls.find(
        (call) => call[2]?.delivery?.sourceMessageId === 61,
      )
      expect(replyInput?.[2]).toMatchObject({ routing: "reply", replyToMessageId: 100 })
      expect(replyInput?.[1]).not.toContain("https://example.com/status")
      expect(replyInput?.[2]?.unresolvedReplyPrompt).not.toContain("處理中")
      const articleInput = sessions.submit.mock.calls.find(
        (call) => call[2]?.delivery?.sourceMessageId === 62,
      )
      expect(articleInput?.[2]).toMatchObject({ routing: "article" })
      expect(articleInput?.[1]).not.toContain("https://example.com/status")
      expect(load).not.toHaveBeenCalled()
    } finally {
      statusAcknowledged.resolve()
      firstAnswer.resolve()
      await Promise.all([first, reply, article])
    }
  })

  it("does not wait for an unrelated status acknowledgement after its target is known", async () => {
    const firstStatus = deferred()
    const secondStatus = deferred()
    const secondAnswer = deferred()
    let statusCount = 0
    const { bot, sessions } = setup({
      beforeResponse: async (method) => {
        if (method !== "sendRichMessage") return
        statusCount++
        if (statusCount === 1) await firstStatus.promise
        if (statusCount === 2) await secondStatus.promise
      },
      submit: async (_chatId, _prompt, input = {}) => {
        input.onAccepted?.()
        if (input.delivery?.sourceMessageId === 81) await secondAnswer.promise
        return { kind: "completed", text: "Answer" }
      },
    })
    const first = bot.handleUpdate(message(80, "/f First article"))
    const second = bot.handleUpdate(message(81, "/f Second article"))
    let reply: Promise<void> | undefined
    try {
      await vi.waitFor(() => expect(statusCount).toBe(2))
      reply = bot.handleUpdate(
        message(82, "Explain", {
          reply: { id: 101, text: "處理中…", bot: true },
        }),
      )
      secondStatus.resolve()
      await vi.waitFor(() => expect(sessions.submit).toHaveBeenCalledTimes(2))
      await reply
      expect(sessions.submit.mock.calls.map((call) => call[2]?.delivery?.sourceMessageId)).toEqual([
        81, 82,
      ])
      expect(submission(sessions, 1).input).toMatchObject({
        routing: "reply",
        replyToMessageId: 101,
      })
      expect(submission(sessions, 1).input.unresolvedReplyPrompt).not.toContain("處理中")
    } finally {
      firstStatus.resolve()
      secondStatus.resolve()
      secondAnswer.resolve()
      await Promise.all([first, second, reply])
    }
  })

  it("orders main preprocessing while a reply waits independently", async () => {
    const firstAdmission = deferred()
    const pendingReply = deferred()
    const { bot, sessions } = setup({
      submit: async (_chatId, _prompt, input = {}) => {
        if (input.delivery?.sourceMessageId === 20) await firstAdmission.promise
        if (input.routing === "reply") await pendingReply.promise
        input.onAccepted?.()
        return { kind: "completed", text: "Answer" }
      },
    })
    const first = bot.handleUpdate(message(20, "@test_bot First"))
    const second = bot.handleUpdate(message(21, "@test_bot Second"))
    const reply = bot.handleUpdate(
      message(22, "@test_bot Reply", { reply: { id: 20, text: "First" } }),
    )
    try {
      await vi.waitFor(() => expect(sessions.submit).toHaveBeenCalledTimes(2))
      expect(sessions.submit.mock.calls.map((call) => call[2]?.delivery?.sourceMessageId)).toEqual([
        20, 22,
      ])
      firstAdmission.resolve()
      await Promise.all([first, second])
      expect(submission(sessions, 2).input).toMatchObject({
        routing: "main",
        delivery: { sourceMessageId: 21 },
      })
    } finally {
      firstAdmission.resolve()
      pendingReply.resolve()
      await Promise.all([first, second, reply])
    }
  })

  it("invalidates main and reply admission generations without blocking new main input", async () => {
    const admission = deferred()
    const { bot, sessions, pendingRefs } = setup({
      submit: async (_chatId, _prompt, input = {}) => {
        if (input.delivery?.sourceMessageId !== 73) await admission.promise
        input.onAccepted?.()
        return { kind: "completed", text: "Answer" }
      },
    })
    const first = bot.handleUpdate(message(70, "@test_bot First"))
    const queued = bot.handleUpdate(message(71, "@test_bot Queued"))
    const reply = bot.handleUpdate(
      message(72, "@test_bot Reply", { reply: { id: 70, text: "First" } }),
    )
    try {
      await vi.waitFor(() => expect(sessions.submit).toHaveBeenCalledTimes(2))
      await bot.handleUpdate(message(74, "/cancel"))
      expect(submission(sessions).input.isCurrent?.()).toBe(false)
      expect(submission(sessions, 1).input.isCurrent?.()).toBe(false)
      await bot.handleUpdate(message(73, "@test_bot New main"))
      expect(submission(sessions, 2).input).toMatchObject({
        routing: "main",
        delivery: { sourceMessageId: 73 },
      })
    } finally {
      admission.resolve()
      await Promise.all([first, queued, reply])
    }
    expect(sessions.submit).toHaveBeenCalledTimes(3)
    expect(pendingRefs.every((ref) => ref.cleanup.mock.calls.length === 1)).toBe(true)
  })

  it.each(["cancel", "reset"] as const)(
    "%s aborts article loading and releases pending references",
    async (command) => {
      const started = deferred()
      let loadSignal: AbortSignal | undefined
      const load: PublicUrlLoader["load"] = async (_url, input) => {
        loadSignal = input?.signal
        started.resolve()
        return new Promise((_resolve, reject) => {
          loadSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Cancelled", "AbortError")),
            { once: true },
          )
        })
      }
      const { bot, sessions, pendingRefs } = setup({ articleUrlLoader: { load } })
      const article = bot.handleUpdate(message(30, "/f https://example.com/article"))
      await started.promise
      await bot.handleUpdate(message(31, `/${command}`))
      await article
      expect(loadSignal?.aborted).toBe(true)
      expect(sessions[command]).toHaveBeenCalledWith(-100)
      expect(sessions.submit).not.toHaveBeenCalled()
      expect(pendingRefs.every((ref) => ref.cleanup.mock.calls.length === 1)).toBe(true)
      await bot.handleUpdate(message(32, "@test_bot New main request"))
      expect(submission(sessions).input).toMatchObject({ routing: "main" })
    },
  )

  it("releases source and loading-status references on input failure", async () => {
    const { bot, sessions, pendingRefs } = setup({
      articleUrlLoader: {
        load: async () => {
          throw new Error("Source failed")
        },
      },
    })
    await bot.handleUpdate(message(40, "/f https://example.com/article"))
    expect(sessions.submit).not.toHaveBeenCalled()
    expect(pendingRefs).toHaveLength(2)
    expect(pendingRefs.every((ref) => ref.cleanup.mock.calls.length === 1)).toBe(true)
  })

  it("indexes passive group input without changing addressing rules", async () => {
    const { bot, sessions } = setup()
    await bot.handleUpdate(message(50, "Not addressed", { reply: { id: 40, text: "User source" } }))
    expect(sessions.submit).not.toHaveBeenCalled()
    expect(sessions.appendPassiveContext).toHaveBeenCalledWith(
      -100,
      expect.stringContaining("Not addressed"),
      50,
    )
  })
})
