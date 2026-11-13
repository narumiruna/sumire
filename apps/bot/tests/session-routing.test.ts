import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import type { ConversationId } from "@earendil-works/pi-durable"
import type { Transformer } from "grammy"
import type { Message, Update, UserFromGetMe } from "grammy/types"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DurableSession } from "../src/agent/durable/session.js"
import {
  BotSessionDoc,
  ConversationPurposeDoc,
  OutboxDoc,
  type ResponseDelivery,
} from "../src/agent/durable/state.js"
import { TelegramReplyIndex } from "../src/agent/reply-index.js"
import {
  ChatSessionRegistry,
  type SubmissionOptions,
  type SubmissionResult,
} from "../src/agent/session-registry.js"
import { createTelegramAgentBot } from "../src/telegram/bot.js"
import { createPiFixture } from "./helpers/pi-fixture.js"
import { telegramPayloadText } from "./helpers/telegram-payload.js"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(maxRecords = 1_000) {
  const pi = await createPiFixture()
  const owners = new Map<number, DurableSession>()
  const registries: ChatSessionRegistry[] = []
  const releases: Array<() => void> = []
  const work: Promise<unknown>[] = []
  const open = () => {
    const registry = new ChatSessionRegistry(
      async (chatId) => {
        const owner = await pi.createSession(chatId)
        owners.set(chatId, owner)
        return owner
      },
      pi.settings.botSessionLogDir,
      pi.logger,
      {
        control: pi.factory.control,
        replyTreeEnabled: true,
        replyTreeMaxRecordsPerChat: maxRecords,
      },
    )
    registries.push(registry)
    return registry
  }
  let registry = open()
  const owner = (chatId = -100) => {
    const session = owners.get(chatId)
    if (!session) throw new Error("Missing real session owner")
    return session
  }
  const pause = () => {
    const release = pi.pauseNextRequest()
    releases.push(release)
    return release
  }
  const submit = (text: string, options: SubmissionOptions, chatId = -100) => {
    const result = registry.submit(chatId, text, options)
    // Tests can fail while another request is blocked. Keep cleanup rejections observed.
    void result.catch(() => {})
    work.push(result)
    return result
  }
  const answer = async (text: string, source: number, options: SubmissionOptions = {}) => {
    pi.enqueueAnswer(`Answer: ${text}`)
    return submit(text, {
      routing: "main",
      delivery: delivery(source),
      ...options,
    })
  }
  cleanups.push(async () => {
    await Promise.all(registries.map((item) => item.dispose()))
    for (const release of releases) release()
    await Promise.allSettled(work)
    await pi.cleanup()
  })
  return {
    pi,
    owner,
    pause,
    submit,
    answer,
    get registry() {
      return registry
    },
    async reopen() {
      await registry.dispose()
      registry = open()
      return registry
    },
  }
}

async function within<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 5_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function delivery(
  sourceMessageId: number,
  mode: ResponseDelivery["mode"] = "default",
): ResponseDelivery {
  return { sourceMessageId, statusMessageId: sourceMessageId + 1_000, mode }
}

function checkpoint(result: SubmissionResult) {
  if (!("checkpoint" in result) || !result.checkpoint) throw new Error("Missing request checkpoint")
  return result.checkpoint
}

async function pending(owner: DurableSession) {
  return (await owner.harness.snapshot(OutboxDoc, context))?.pending ?? []
}

async function recordFor(owner: DurableSession, source: number) {
  const item = (await pending(owner)).find((item) => item.delivery.sourceMessageId === source)
  if (!item) throw new Error(`Missing outbox source ${source}`)
  return item
}

async function assertOwned(owner: DurableSession, result: SubmissionResult, source: number) {
  const saved = await recordFor(owner, source)
  const native = await owner.harness.commit(
    (tx) => tx.submissionByRequest(saved.conversationId, saved.requestId),
    context,
  )
  expect(native).toMatchObject({ type: "input", status: "done" })
  if (native?.type !== "input" || native.status !== "done") throw new Error("Missing native answer")
  expect(saved.answerEntryId).toBe(native.answer)
  expect(saved.relatedRequestIds ?? []).toEqual([])
  expect(checkpoint(result)).toMatchObject({
    sessionId: owner.sessionId,
    entryId: `${saved.conversationId}:${native.answer}`,
    requestId: saved.requestId,
  })
  const entry = await owner.harness.commit((tx) => tx.entry(native.answer), context)
  expect(entry?.conversationId).toBe(saved.conversationId)
  expect(JSON.stringify(entry?.model)).toContain(result.text)
  return saved
}

async function transcript(owner: DurableSession, conversationId: number) {
  const conversation = await owner.harness.conversation(conversationId as ConversationId, context)
  if (!conversation) throw new Error("Missing conversation")
  return JSON.stringify(
    (await conversation.entries({ order: "ascending" }, 100, undefined, context)).items,
  )
}

async function parent(owner: DurableSession, conversationId: number) {
  return (
    await owner.harness.commit((tx) => tx.conversation(conversationId as ConversationId), context)
  )?.parent
}

const requestText = (pi: Awaited<ReturnType<typeof createPiFixture>>, index: number) =>
  JSON.stringify(pi.requests[index]?.messages)

async function requests(pi: Awaited<ReturnType<typeof createPiFixture>>, count: number) {
  await vi.waitFor(() => expect(pi.requests).toHaveLength(count), { timeout: 5_000 })
}

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

function update(id: number, text: string, reply?: { id: number; text: string }): Update {
  const chat: Message["chat"] = { id: -100, type: "supergroup", title: "Offline routing" }
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
      ...(reply
        ? {
            reply_to_message: {
              message_id: reply.id,
              date: 1_700_000_000,
              chat,
              from: { id: 7, is_bot: false, first_name: "Alice" },
              text: reply.text,
              reply_to_message: undefined,
            },
          }
        : {}),
    },
  }
}

describe("real registry session routing", () => {
  it.each(["telegram", "durable", "failed"] as const)(
    "keeps a visible final answer as /f source while %s acknowledgement is pending",
    async (phase) => {
      const f = await setup()
      await f.answer("seed", 1)
      let release = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let reached = false
      const publish = vi.fn(async () => "https://morsel.example/s/final-article")
      const telegram = createTelegramAgentBot(
        { ...f.pi.settings, botToken: "test-token" },
        f.registry,
        f.pi.logger,
        {
          control: f.pi.factory.control,
          botInfo,
          morselPublisher: { isConfigured: true, publish },
        },
      )
      let messageId = 500
      const transport: Transformer = async (_previous, method, payload) => {
        const data = payload as Record<string, unknown>
        const text = telegramPayloadText(payload) ?? ""
        if (phase === "telegram" && text === "Visible final answer") {
          reached = true
          await gate
        }
        return {
          ok: true,
          result: {
            message_id: method === "sendRichMessage" ? messageId++ : Number(data.message_id),
            date: 1_700_000_000,
            chat: { id: -100, type: "supergroup", title: "Offline routing" },
            rich_message: { blocks: [{ type: "paragraph", text }] },
          },
        } as never
      }
      telegram.bot.api.config.use(transport)
      const owner = f.owner()
      const acknowledge = owner.acknowledge.bind(owner)
      const spy = vi.spyOn(owner, "acknowledge").mockImplementation(async (id) => {
        const current = (await pending(owner)).find((item) => item.requestId === id)
        if (current?.delivery.sourceMessageId === 10) {
          if (phase === "failed") {
            reached = true
            throw new Error("Offline acknowledgement failure")
          }
          if (phase === "durable") {
            reached = true
            await gate
          }
        }
        await acknowledge(id)
      })
      f.pi.enqueueAnswer("Visible final answer")
      const first = telegram.bot.handleUpdate(update(10, "@test_bot answer"))
      try {
        await vi.waitFor(() => expect(reached).toBe(true))
        expect(await f.registry.isPendingStatus(-100, 500)).toBe(true)
        f.pi.enqueueAnswer("# Converted final answer")
        const article = update(11, "/f", { id: 500, text: "Visible final answer" })
        if (!article.message?.reply_to_message) throw new Error("Missing reply fixture")
        article.message.reply_to_message.from = botInfo
        await within(telegram.bot.handleUpdate(article), "article from visible final answer")
        expect(publish).toHaveBeenCalledOnce()
        expect(requestText(f.pi, 2)).toContain("Visible final answer")
        expect(requestText(f.pi, 2)).not.toContain("Content: 處理中")
      } finally {
        release()
        await first
        spy.mockRestore()
      }
    },
  )

  it("detaches cancelled article observers without deleting their history", async () => {
    const f = await setup()
    await f.answer("main seed", 1)
    const owner = f.owner()
    const observe = owner.harness.observeConversation.bind(owner.harness)
    const detaches: ReturnType<typeof vi.fn>[] = []
    const conversations: number[] = []
    const spy = vi
      .spyOn(owner.harness, "observeConversation")
      .mockImplementation(async (...args) => {
        const observation = await observe(...args)
        conversations.push(Number(args[0]))
        const detach = vi.fn(() => observation.detach())
        detaches.push(detach)
        return { ...observation, detach }
      })
    try {
      for (let index = 0; index < 3; index++) {
        const release = f.pause()
        const work = f.submit(`cancelled article ${index}`, {
          routing: "article",
          delivery: delivery(100 + index),
        })
        await vi.waitFor(() => expect(f.pi.requests).toHaveLength(index + 2))
        await within(f.registry.cancel(-100), "cancel child observations")
        await vi.waitFor(() => expect(f.pi.disconnectedRequests).toBeGreaterThanOrEqual(index + 1))
        release()
        await work
        expect(detaches).toHaveLength(index + 1)
        for (const detach of detaches) expect(detach).toHaveBeenCalledOnce()
      }
      for (const id of conversations) {
        const history = await owner.harness.conversation(id as ConversationId, context)
        expect(history).toBeDefined()
        expect(JSON.stringify((await history?.context(context))?.entries)).toContain(
          "cancelled article",
        )
      }
    } finally {
      spy.mockRestore()
    }
  })

  it("routes real Telegram /f, main, and user replies through the real registry without crossing publication or reply targets", async () => {
    const f = await setup()
    const published: string[] = []
    const telegram = createTelegramAgentBot(
      { ...f.pi.settings, botToken: "offline-test-token" },
      f.registry,
      f.pi.logger,
      {
        control: f.pi.factory.control,
        botInfo,
        morselPublisher: {
          isConfigured: true,
          publish: async (text) => {
            published.push(text)
            return `https://morsel.example/s/${published.length}`
          },
        },
      },
    )
    const calls: Array<{
      method: string
      payload: Record<string, unknown>
      id: number
      text: string
    }> = []
    const statuses = new Map<number, number>()
    let nextId = 1_000
    const transformer: Transformer = async (_previous, method, payload) => {
      const data = payload as Record<string, unknown>
      const id = method === "sendRichMessage" ? nextId++ : Number(data.message_id)
      const text = telegramPayloadText(payload) ?? ""
      calls.push({ method, payload: data, id, text })
      const reply = data.reply_parameters as { message_id?: number } | undefined
      if (
        method === "sendRichMessage" &&
        reply?.message_id !== undefined &&
        !statuses.has(reply.message_id)
      )
        statuses.set(reply.message_id, id)
      return {
        ok: true,
        result: {
          message_id: id,
          date: 1_700_000_000,
          chat: { id: -100, type: "supergroup", title: "Offline routing" },
          from: botInfo,
          rich_message: { blocks: [{ type: "paragraph", text }] },
        },
      } as never
    }
    telegram.bot.api.config.use(transformer)
    f.pi.enqueueAnswer("Bot seed answer")
    await telegram.bot.handleUpdate(update(10, "@test_bot Bot seed history"))
    const releaseA = f.pause()
    const article = telegram.bot.handleUpdate(update(20, "/f First article source"))
    void article.catch(() => {})
    await requests(f.pi, 2)
    const a = await recordFor(f.owner(), 20)
    let articleDone = false
    void article.then(() => {
      articleDone = true
    })
    try {
      const releaseB = f.pause()
      const main = telegram.bot.handleUpdate(update(30, "@test_bot Bot main B"))
      await requests(f.pi, 3)
      const b = await recordFor(f.owner(), 30)
      f.pi.enqueueAnswer("Bot main B answer")
      releaseB()
      await main
      const releaseC = f.pause()
      const reply = telegram.bot.handleUpdate(
        update(40, "@test_bot Bot reply C", { id: 30, text: "@test_bot Bot main B" }),
      )
      await requests(f.pi, 4)
      const c = await recordFor(f.owner(), 40)
      f.pi.enqueueAnswer("Bot reply C answer")
      releaseC()
      await reply
      expect(articleDone).toBe(false)
      expect(new Set([a.conversationId, b.conversationId, c.conversationId]).size).toBe(3)
      expect(b.conversationId).toBe(f.owner().conversationId)
      expect(a.delivery).toMatchObject({
        sourceMessageId: 20,
        statusMessageId: statuses.get(20),
        mode: "publish",
      })
      expect(b.delivery).toMatchObject({
        sourceMessageId: 30,
        statusMessageId: statuses.get(30),
        mode: "default",
      })
      expect(c.delivery).toMatchObject({
        sourceMessageId: 40,
        statusMessageId: statuses.get(40),
        mode: "default",
      })
      expect(requestText(f.pi, 1)).not.toContain("Bot seed history")
      expect(requestText(f.pi, 2)).not.toContain("First article source")
      expect(requestText(f.pi, 3)).toContain("Bot main B")
      expect(requestText(f.pi, 3)).not.toMatch(/First article source|Bot main B answer/)
      f.pi.enqueueAnswer("Second article answer")
      await telegram.bot.handleUpdate(update(50, "/f Second article source"))
      expect(requestText(f.pi, 4)).not.toMatch(
        /Bot seed history|First article source|Bot main B|Bot reply C/,
      )
      expect(published).toEqual(["Second article answer"])
      f.pi.enqueueAnswer("First article answer")
      releaseA()
      await article
      expect(published).toEqual(["Second article answer", "First article answer"])
      const index = new TelegramReplyIndex(
        f.pi.settings.botSessionLogDir,
        1_000,
        1_000_000,
        f.pi.logger,
      )
      for (const [record, text] of [
        [a, "First article answer"],
        [b, "Bot main B answer"],
        [c, "Bot reply C answer"],
      ] as const) {
        const native = await f
          .owner()
          .harness.commit(
            (tx) => tx.submissionByRequest(record.conversationId, record.requestId),
            context,
          )
        if (native?.type !== "input" || native.status !== "done")
          throw new Error("Missing bot native answer")
        expect(await transcript(f.owner(), record.conversationId)).toContain(text)
        expect(await index.resolve(-100, record.delivery.statusMessageId as number)).toEqual({
          sessionId: f.owner().sessionId,
          entryId: `${record.conversationId}:${native.answer}`,
        })
      }
      expect(
        calls.some((call) => call.id === statuses.get(30) && call.text === "Bot main B answer"),
      ).toBe(true)
      expect(
        calls.some((call) => call.id === statuses.get(40) && call.text === "Bot reply C answer"),
      ).toBe(true)
      expect(
        calls.some(
          (call) => call.id === statuses.get(20) && call.text === "https://morsel.example/s/2",
        ),
      ).toBe(true)
      expect(
        calls.some(
          (call) => call.id === statuses.get(50) && call.text === "https://morsel.example/s/1",
        ),
      ).toBe(true)
      expect(await pending(f.owner())).toEqual([])
    } finally {
      // Abort before opening a blocked HTTP gate if an assertion failed.
      if (!articleDone) {
        await f.registry.cancel(-100)
        await vi.waitFor(() => expect(f.pi.disconnectedRequests).toBeGreaterThanOrEqual(1))
        releaseA()
      }
      await Promise.allSettled([article])
      await telegram.stop()
    }
  })
  it.each(["missing", "evicted", "wrong-session", "missing-entry"] as const)(
    "uses a fresh bounded fallback for a %s mapping instead of the main leaf",
    async (kind) => {
      const f = await setup(1)
      const original = await f.answer("Main history must stay private", 10)
      const rootId = f.owner().sessionId
      const main = f.owner().conversationId
      // With a one-record index, delivery evicts the admitted user input mapping.
      await f.registry.recordDelivery(-100, checkpoint(original), [110])
      await f.registry.dispose()
      const index = new TelegramReplyIndex(
        f.pi.settings.botSessionLogDir,
        1,
        1_000_000,
        f.pi.logger,
      )
      if (kind === "wrong-session" || kind === "missing-entry") {
        await index.record(-100, [999], {
          sessionId: kind === "wrong-session" ? "other-chat-storage" : rootId,
          entryId: kind === "wrong-session" ? checkpoint(original).entryId : `${main}:999999`,
        })
      }
      await f.reopen()
      const result = await f.answer("Fallback question", 20, {
        routing: "reply",
        replyToMessageId: kind === "evicted" ? 10 : 999,
        unresolvedReplyPrompt: "Fallback question with BOUNDED Telegram reply context",
      })
      const saved = await assertOwned(f.owner(), result, 20)
      expect(saved.conversationId).not.toBe(main)
      expect(await parent(f.owner(), saved.conversationId)).toBeUndefined()
      expect(requestText(f.pi, 1)).toContain("BOUNDED Telegram reply context")
      expect(requestText(f.pi, 1)).not.toContain("Main history must stay private")
      await f.answer("Main after fallback", 30)
      expect((await recordFor(f.owner(), 30)).conversationId).toBe(main)
      expect(requestText(f.pi, 2)).toContain("Main history must stay private")
      expect(requestText(f.pi, 2)).not.toContain("BOUNDED Telegram reply context")
    },
  )

  it.each(["source", "status"] as const)(
    "waits for only the pending %s request, not an unrelated blocked main",
    async (alias) => {
      const f = await setup()
      const releaseInput = f.registry.trackPendingInput(-100, 20, 1020)
      try {
        let replyDone = false
        const reply = f.submit("Pending dependent reply", {
          routing: "reply",
          replyToMessageId: alias === "source" ? 20 : 1020,
          delivery: delivery(40),
          unresolvedReplyPrompt: "WRONG fallback pending status text",
        })
        void reply.then(() => {
          replyDone = true
        })
        const releaseMain = f.pause()
        const main = f.submit("Unrelated blocked main", { routing: "main", delivery: delivery(30) })
        await requests(f.pi, 1)
        const releaseArticle = f.pause()
        const article = f.submit("Pending article source", {
          routing: "article",
          delivery: delivery(20, "publish"),
        })
        await requests(f.pi, 2)
        expect(replyDone).toBe(false)
        f.pi.enqueueAnswer("Pending article answer")
        f.pi.enqueueAnswer("Pending dependent answer")
        releaseArticle()
        const sourceResult = await article
        const replyResult = await reply
        expect(replyResult.text).toBe("Pending dependent answer")
        const sourceSaved = await assertOwned(f.owner(), sourceResult, 20)
        const replySaved = await assertOwned(f.owner(), replyResult, 40)
        const native = await f
          .owner()
          .harness.commit(
            (tx) => tx.submissionByRequest(sourceSaved.conversationId, sourceSaved.requestId),
            context,
          )
        if (native?.type !== "input" || native.status !== "done")
          throw new Error("Source did not settle")
        expect(await parent(f.owner(), replySaved.conversationId)).toEqual({
          conversationId: sourceSaved.conversationId,
          at: alias === "source" ? native.entry : native.answer,
        })
        expect(requestText(f.pi, 2)).toContain("Pending article source")
        expect(requestText(f.pi, 2)).not.toMatch(/Unrelated blocked main|WRONG fallback/)
        if (alias === "source") expect(requestText(f.pi, 2)).not.toContain("Pending article answer")
        else expect(requestText(f.pi, 2)).toContain("Pending article answer")
        const mainSaved = await recordFor(f.owner(), 30)
        expect(
          await f
            .owner()
            .harness.commit(
              (tx) => tx.submissionByRequest(mainSaved.conversationId, mainSaved.requestId),
              context,
            ),
        ).not.toMatchObject({ status: "done" })
        f.pi.enqueueAnswer("Main after dependency finished")
        releaseMain()
        await assertOwned(f.owner(), await main, 30)
      } finally {
        releaseInput()
      }
    },
  )
  it("settles main B and reply C while article A is blocked, with native answer and delivery ownership", async () => {
    const f = await setup()
    const seed = await f.answer("Seed main", 10)
    await f.registry.recordDelivery(-100, checkpoint(seed), [110])
    const main = f.owner().conversationId
    const release = f.pause()
    const article = f.submit("Article A source", {
      routing: "article",
      delivery: delivery(20, "publish"),
    })
    await requests(f.pi, 2)
    let articleDone = false
    void article.then(() => {
      articleDone = true
    })
    const mainAnswer = await f.answer("Main B question", 30)
    const replyAnswer = await f.answer("Reply C question", 40, {
      routing: "reply",
      replyToMessageId: 110,
    })
    expect(articleDone).toBe(false)
    expect(mainAnswer).toMatchObject({ kind: "completed", text: "Answer: Main B question" })
    expect(replyAnswer).toMatchObject({ kind: "completed", text: "Answer: Reply C question" })
    const b = await assertOwned(f.owner(), mainAnswer, 30)
    const c = await assertOwned(f.owner(), replyAnswer, 40)
    const a = await recordFor(f.owner(), 20)
    expect(new Set([a.conversationId, b.conversationId, c.conversationId]).size).toBe(3)
    expect(b.conversationId).toBe(main)
    expect(a.delivery).toEqual(delivery(20, "publish"))
    expect(c.delivery).toEqual(delivery(40))
    expect(requestText(f.pi, 1)).not.toMatch(/Seed main|Main B question|Reply C question/)
    expect(requestText(f.pi, 2)).not.toContain("Article A source")
    expect(requestText(f.pi, 3)).toContain("Seed main")
    expect(requestText(f.pi, 3)).not.toMatch(/Article A source|Main B question/)
    f.pi.enqueueAnswer("Article A owned answer")
    release()
    const articleAnswer = await article
    expect(articleAnswer.text).toBe("Article A owned answer")
    await assertOwned(f.owner(), articleAnswer, 20)
    expect(await transcript(f.owner(), main)).not.toMatch(/Article A owned answer|Reply C question/)
    expect(await f.owner().harness.snapshot(BotSessionDoc, context)).toMatchObject({
      mainConversation: main,
      activeConversation: main,
    })
  })

  it("recovers settled main and reply deliveries before a blocked article, then retains delivered user and bot checkpoints", async () => {
    const f = await setup()
    const seed = await f.answer("Recovery seed", 10)
    await f.registry.recordDelivery(-100, checkpoint(seed), [110])
    const releaseOld = f.pause()
    const article = f.submit("Restarted article source", {
      routing: "article",
      delivery: delivery(20, "publish"),
    })
    await requests(f.pi, 2)
    const main = await f.answer("Recovery main", 30)
    const branch = await f.answer("Recovery branch", 40, {
      routing: "reply",
      replyToMessageId: 110,
    })
    const mainId = f.owner().conversationId
    const articleRecord = await recordFor(f.owner(), 20)
    const before = f.pi.requests.length
    await f.reopen()
    await Promise.allSettled([article])
    await vi.waitFor(() => expect(f.pi.disconnectedRequests).toBe(1))
    releaseOld()
    const releaseResumed = f.pause()
    const delivered: Array<{ source: number; text: string; mode: string }> = []
    await f.registry.recover([-100], async (chat, answer, target, point, isCurrent) => {
      expect(isCurrent()).toBe(true)
      delivered.push({ source: target.sourceMessageId, text: answer.text, mode: target.mode })
      await f.registry.recordDelivery(chat, point, [target.sourceMessageId + 200], false)
      return true
    })
    await requests(f.pi, before + 1)
    await vi.waitFor(() => expect(delivered).toHaveLength(2))
    expect(delivered).toEqual(
      expect.arrayContaining([
        { source: 30, text: main.text, mode: "default" },
        { source: 40, text: branch.text, mode: "default" },
      ]),
    )
    expect(delivered.some((item) => item.source === 20)).toBe(false)
    expect(f.owner().conversationId).toBe(mainId)
    // A live transport read prevents recovery-only owner eviction after the last ack.
    await f.registry.appendPassiveContext(-100, "Main remains loaded after recovery")
    f.pi.enqueueAnswer("Restarted article final")
    releaseResumed()
    await vi.waitFor(() => expect(delivered).toHaveLength(3))
    await vi.waitFor(async () => expect(await pending(f.owner())).toEqual([]))
    expect(delivered.find((item) => item.source === 20)).toEqual({
      source: 20,
      text: "Restarted article final",
      mode: "publish",
    })
    expect(f.pi.requests).toHaveLength(before + 1)
    const native = await f
      .owner()
      .harness.commit(
        (tx) => tx.submissionByRequest(articleRecord.conversationId, articleRecord.requestId),
        context,
      )
    if (native?.type !== "input" || native.status !== "done")
      throw new Error("Missing recovered article")
    for (const [i, messageId] of [20, 220].entries()) {
      const result = await f.answer(`Reply after recovery ${messageId}`, 60 + i, {
        routing: "reply",
        replyToMessageId: messageId,
        unresolvedReplyPrompt: "WRONG recovered fallback",
      })
      const saved = await assertOwned(f.owner(), result, 60 + i)
      expect(await parent(f.owner(), saved.conversationId)).toEqual({
        conversationId: articleRecord.conversationId,
        at: i === 0 ? native.entry : native.answer,
      })
      expect(requestText(f.pi, before + 1 + i)).toContain("Restarted article source")
      expect(requestText(f.pi, before + 1 + i)).not.toContain("WRONG recovered fallback")
    }
  })

  it("retains partial media on failure without borrowing an unrelated main answer, including recovery", async () => {
    const f = await setup()
    const previous = await f.answer("Previous main answer", 10)
    await f.registry.recordDelivery(-100, checkpoint(previous), [110])
    const release = f.pause()
    const failed = f.submit("Failed article with partial media", {
      routing: "article",
      delivery: delivery(20, "publish"),
    })
    await requests(f.pi, 2)
    const later = await f.answer("Unrelated later main answer", 30)
    await f.registry.recordDelivery(-100, checkpoint(later), [130])
    const media = {
      id: "00000000-0000-4000-8000-000000000001",
      extension: "png" as const,
      mimeType: "image/png" as const,
      width: 1,
      height: 1,
      byteLength: 1,
      sha256: "fixture",
      taskId: 1,
      callId: "partial-owned-image",
      messageId: 500,
    }
    await f.owner().harness.commit(async (tx) => {
      const item = (await tx.doc(OutboxDoc)).pending.find(
        (item) => item.delivery.sourceMessageId === 20,
      )
      if (!item) throw new Error("Missing failing request")
      item.media = [media]
      item.textMessageIds = [501]
    }, context)
    f.pi.enqueueFailure()
    release()
    const result = await failed
    expect(result).toMatchObject({
      text: "",
      media: [media],
      textMessageIds: [501],
      settlement: { status: "unanswered", reason: "model_error" },
    })
    const saved = await recordFor(f.owner(), 20)
    expect(saved.answerEntryId).toBeUndefined()
    expect(
      await f
        .owner()
        .harness.commit(
          (tx) => tx.submissionByRequest(saved.conversationId, saved.requestId),
          context,
        ),
    ).toMatchObject({ status: "unanswered", reason: "model_error" })
    const before = f.pi.requests.length
    await f.reopen()
    const recovered: Array<{ text: string; media: unknown; target: ResponseDelivery }> = []
    await f.registry.recover([-100], async (_chat, answer, target) => {
      recovered.push({ text: answer.text, media: answer.media, target })
      return false
    })
    await vi.waitFor(() =>
      expect(recovered).toEqual([{ text: "", media: [media], target: delivery(20) }]),
    )
    expect(f.pi.requests).toHaveLength(before)
    expect((await recordFor(f.owner(), 20)).textMessageIds).toEqual([501])
    await f.owner().acknowledge(saved.requestId)
    expect((await f.owner().harness.snapshot(OutboxDoc, context))?.mediaReceipts).toContainEqual({
      requestId: saved.requestId,
      id: media.id,
      messageId: 500,
    })
  })

  it("reserves four reopened native runs before a crash-window intent and new foreground work without blocking ready deliveries", async () => {
    const f = await setup()
    const ready = await f.answer("Ready peer before crash", 5, { routing: "article" })
    const old: Promise<SubmissionResult>[] = []
    const oldReleases: Array<() => void> = []
    for (let i = 0; i < 4; i++) {
      oldReleases.push(f.pause())
      old.push(
        f.submit(`Retained native article ${i}`, {
          routing: "article",
          delivery: delivery(10 + i, "publish"),
        }),
      )
      await requests(f.pi, i + 2)
    }
    const retained = (await pending(f.owner())).filter(
      (item) => item.delivery.sourceMessageId !== 5,
    )
    const unsent = await f.owner().createConversation(undefined, "article")
    const intent = {
      requestId: "outbox-before-native-submit",
      conversationId: unsent.conversationId as ConversationId,
      content: "Older crash-window article intent",
      delivery: delivery(50, "publish"),
    }
    await f.owner().harness.commit(async (tx) => {
      // The blocked intent precedes the ready peer in recovery's scan order.
      ;(await tx.doc(OutboxDoc)).pending.unshift(intent)
      expect(await tx.submissionByRequest(intent.conversationId, intent.requestId)).toBeUndefined()
    }, context)
    await f.reopen()
    await Promise.allSettled(old)
    await vi.waitFor(() => expect(f.pi.disconnectedRequests).toBe(4))
    for (const release of oldReleases) release()

    // Hold each resumed provider response independently. Every fixture answer is
    // consumed before its gate closes, including when an assertion fails.
    const gates: Array<() => void> = []
    let closing = false
    const originalFetch = globalThis.fetch
    const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (!url.startsWith(f.pi.endpoint)) return originalFetch(input, init)
      let release = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      gates.push(release)
      f.pi.enqueueAnswer(`Reopened owned answer ${gates.length}`)
      const response = await originalFetch(input, init)
      if (!closing) await gate
      return response
    })
    try {
      // Metadata lookup opens the owner without resuming any native work.
      expect(await f.registry.isPendingStatus(-100, 1050)).toBe(true)
      expect(await pending(f.owner())).toHaveLength(6)
      const accepted = vi.fn()
      const foreground = f.submit("New foreground must follow saved intent", {
        routing: "article",
        delivery: delivery(60),
        onAccepted: accepted,
      })
      await vi.waitFor(async () =>
        expect(
          (await f.owner().harness.commit((tx) => tx.scanConversations({}, 100), context)).items,
        ).toHaveLength(8),
      )
      expect(accepted).not.toHaveBeenCalled()
      const delivered: number[] = []
      await within(
        f.registry.recover([-100], async (_chat, _answer, target) => {
          delivered.push(target.sourceMessageId)
          return true
        }),
        "start recovery without waiting for an admission slot",
      )
      await requests(f.pi, 9)
      await vi.waitFor(() => expect(delivered).toEqual([5]))
      expect(gates).toHaveLength(4)
      expect(accepted).not.toHaveBeenCalled()
      expect(await pending(f.owner())).toHaveLength(5)
      expect(
        await f
          .owner()
          .harness.commit(
            (tx) => tx.submissionByRequest(intent.conversationId, intent.requestId),
            context,
          ),
      ).toBeUndefined()
      for (const record of retained)
        expect(
          await f
            .owner()
            .harness.commit(
              (tx) => tx.submissionByRequest(record.conversationId, record.requestId),
              context,
            ),
        ).not.toMatchObject({ status: "done" })
      expect(checkpoint(ready).sessionId).toBe(f.owner().sessionId)

      gates[0]?.()
      await requests(f.pi, 10)
      expect(requestText(f.pi, 9)).toContain(intent.content)
      expect(requestText(f.pi, 9)).not.toContain("New foreground")
      expect(accepted).not.toHaveBeenCalled()
      expect(gates).toHaveLength(5)
      expect(
        await f
          .owner()
          .harness.commit(
            (tx) => tx.submissionByRequest(intent.conversationId, intent.requestId),
            context,
          ),
      ).toMatchObject({ type: "input" })
      gates[1]?.()
      await requests(f.pi, 11)
      expect(accepted).toHaveBeenCalledOnce()
      expect(requestText(f.pi, 10)).toContain("New foreground must follow saved intent")
      for (const release of gates) release()
      await assertOwned(
        f.owner(),
        await within(foreground, "foreground after reopened admissions"),
        60,
      )
      await vi.waitFor(() =>
        expect(delivered.slice().sort((a, b) => a - b)).toEqual([5, 10, 11, 12, 13, 50]),
      )
      await vi.waitFor(async () =>
        expect((await pending(f.owner())).map((item) => item.delivery.sourceMessageId)).toEqual([
          60,
        ]),
      )
      expect(f.pi.requests).toHaveLength(11)
      expect(f.pi.pendingReplies).toBe(0)
    } finally {
      closing = true
      for (const release of gates) release()
      try {
        await f.registry.dispose()
      } finally {
        provider.mockRestore()
      }
    }
  }, 20_000)

  it.each([false, true])(
    "bounds admission at four and keeps the fifth alive through unrelated ack (reopen=%s)",
    async (reopen) => {
      const f = await setup()
      const unrelated = await f.answer("Cap unrelated completed article", 5, { routing: "article" })
      let releaseFirst = f.pause()
      const first = f.submit("Cap retained article", { routing: "article", delivery: delivery(10) })
      await requests(f.pi, 2)
      if (reopen) {
        await f.reopen()
        await Promise.allSettled([first])
        await vi.waitFor(() => expect(f.pi.disconnectedRequests).toBe(1))
        releaseFirst()
        releaseFirst = f.pause()
        await f.registry.recover([-100], async () => false)
        await requests(f.pi, 3)
      }
      const blocked: Array<{ result: Promise<SubmissionResult>; release: () => void }> = []
      for (let i = 0; i < 3; i++) {
        const release = f.pause()
        const accepted = vi.fn()
        const result = f.submit(`Cap independent ${i}`, {
          routing: "article",
          delivery: delivery(20 + i),
          onAccepted: accepted,
        })
        blocked.push({ result, release })
        await requests(f.pi, (reopen ? 3 : 2) + i + 1)
        expect(accepted).toHaveBeenCalledOnce()
      }
      const admittedCount = f.pi.requests.length
      const fifthAccepted = vi.fn()
      const fifth = f.submit("Cap fifth must wait", {
        routing: "article",
        delivery: delivery(50),
        onAccepted: fifthAccepted,
      })
      // Conversation creation is not admission. Wait until the fifth has a real handle.
      await vi.waitFor(async () =>
        expect(
          (await f.owner().harness.commit((tx) => tx.scanConversations({}, 100), context)).items,
        ).toHaveLength(7),
      )
      expect(fifthAccepted).not.toHaveBeenCalled()
      expect(await pending(f.owner())).toHaveLength(5)
      // A queued handle has no native run or outbox yet. Ack must not dispose it.
      await f.registry.recordDelivery(-100, checkpoint(unrelated), [105])
      expect(await pending(f.owner())).toHaveLength(4)
      expect(fifthAccepted).not.toHaveBeenCalled()
      expect(f.pi.requests).toHaveLength(admittedCount)
      const releaseFifth = f.pause()
      f.pi.enqueueAnswer("Cap first completed")
      releaseFirst()
      if (!reopen) await first
      await requests(f.pi, admittedCount + 1)
      expect(fifthAccepted).toHaveBeenCalledOnce()
      expect((await recordFor(f.owner(), 50)).content).toBe("Cap fifth must wait")
      for (const [i, item] of blocked.entries()) {
        f.pi.enqueueAnswer(`Cap independent answer ${i}`)
        item.release()
        await item.result
      }
      f.pi.enqueueAnswer("Cap fifth answer")
      releaseFifth()
      await assertOwned(f.owner(), await fifth, 50)
      expect(await pending(f.owner())).toHaveLength(5)
    },
  )

  it.each(["source", "status"] as const)(
    "restores a reply to a reopened pending %s before recovery acknowledges its source",
    async (alias) => {
      const f = await setup()
      const releaseOld = f.pause()
      const old = f.submit("Reopened pending article", {
        routing: "article",
        delivery: delivery(20, "publish"),
      })
      await requests(f.pi, 1)
      const source = await recordFor(f.owner(), 20)
      await f.reopen()
      await Promise.allSettled([old])
      await vi.waitFor(() => expect(f.pi.disconnectedRequests).toBe(1))
      releaseOld()
      const release = f.pause()
      const delivered: number[] = []
      await f.registry.recover([-100], async (_chat, _answer, target) => {
        delivered.push(target.sourceMessageId)
        return true
      })
      await requests(f.pi, 2)
      const resolving = vi.spyOn(f.owner(), "resolvePendingReply")
      const reply = f.submit("Reopened dependent question", {
        routing: "reply",
        replyToMessageId: alias === "source" ? 20 : 1020,
        delivery: delivery(30),
        unresolvedReplyPrompt: "WRONG reopened pending fallback",
      })
      await vi.waitFor(() => expect(resolving).toHaveBeenCalledWith(alias === "source" ? 20 : 1020))
      f.pi.enqueueAnswer("Reopened pending answer")
      f.pi.enqueueAnswer("Reopened dependent answer")
      release()
      const result = await reply
      const saved = await assertOwned(f.owner(), result, 30)
      const native = await f
        .owner()
        .harness.commit(
          (tx) => tx.submissionByRequest(source.conversationId, source.requestId),
          context,
        )
      if (native?.type !== "input" || native.status !== "done")
        throw new Error("Missing reopened source")
      expect(await parent(f.owner(), saved.conversationId)).toEqual({
        conversationId: source.conversationId,
        at: alias === "source" ? native.entry : native.answer,
      })
      expect(requestText(f.pi, 2)).not.toContain("WRONG reopened pending fallback")
      expect(requestText(f.pi, 2)).toContain("Reopened pending article")
      expect(delivered).toEqual([20])
    },
  )

  it("rejects bare /f on a persisted pending status after reopen but restores an ordinary reply from its formal answer", async () => {
    const f = await setup()
    const releaseOld = f.pause()
    const old = f.submit("Persisted pending article source", {
      routing: "article",
      delivery: delivery(20, "publish"),
    })
    await requests(f.pi, 1)
    const source = await recordFor(f.owner(), 20)
    await f.reopen()
    await Promise.allSettled([old])
    await vi.waitFor(() => expect(f.pi.disconnectedRequests).toBe(1))
    releaseOld()
    const publish = vi.fn(async () => "https://morsel.example/s/unused")
    const load = vi.fn(async () => {
      throw new Error("Pending progress is not article source")
    })
    const telegram = createTelegramAgentBot(
      { ...f.pi.settings, botToken: "offline-test-token" },
      f.registry,
      f.pi.logger,
      {
        control: f.pi.factory.control,
        botInfo,
        morselPublisher: { isConfigured: true, publish },
        articleUrlLoader: { load },
      },
    )
    const sent: string[] = []
    const transformer: Transformer = async (_previous, _method, payload) => {
      const text = telegramPayloadText(payload) ?? ""
      sent.push(text)
      return {
        ok: true,
        result: {
          message_id: 2000 + sent.length,
          date: 1_700_000_000,
          chat: { id: -100, type: "supergroup", title: "Offline routing" },
          from: botInfo,
          rich_message: { blocks: [{ type: "paragraph", text }] },
        },
      } as never
    }
    telegram.bot.api.config.use(transformer)
    try {
      expect(await f.registry.isPendingStatus(-100, 1020)).toBe(true)
      expect(await f.registry.isPendingStatus(-100, 20)).toBe(false)
      expect(await f.registry.isPendingStatus(-100, 9999)).toBe(false)
      expect(f.pi.requests).toHaveLength(1)
      const command = update(30, "/f", {
        id: 1020,
        text: "正在處理… https://example.com/progress-not-source",
      })
      if (command.message?.reply_to_message) command.message.reply_to_message.from = botInfo
      await within(telegram.bot.handleUpdate(command), "bare /f on reopened pending status")
      expect(sent).toEqual(["請使用 /f <內容>，或回覆要整理的訊息、圖片或文件後傳送 /f。"])
      expect(load).not.toHaveBeenCalled()
      expect(publish).not.toHaveBeenCalled()
      expect(f.pi.requests).toHaveLength(1)
      expect(await pending(f.owner())).toHaveLength(1)

      const release = f.pause()
      await within(
        f.registry.recover([-100], async () => false),
        "start persisted status recovery",
      )
      await requests(f.pi, 2)
      const resolving = vi.spyOn(f.owner(), "resolvePendingReply")
      const reply = f.submit("Ordinary reply to persisted status", {
        routing: "reply",
        replyToMessageId: 1020,
        delivery: delivery(40),
        unresolvedReplyPrompt: "WRONG processing progress fallback",
      })
      await vi.waitFor(() => expect(resolving).toHaveBeenCalledWith(1020))
      const releaseReply = f.pause()
      f.pi.enqueueAnswer("Persisted formal answer")
      release()
      await requests(f.pi, 3)
      f.pi.enqueueAnswer("Ordinary status reply answer")
      releaseReply()
      const result = await within(reply, "ordinary reply to reopened pending status")
      const saved = await assertOwned(f.owner(), result, 40)
      const native = await f
        .owner()
        .harness.commit(
          (tx) => tx.submissionByRequest(source.conversationId, source.requestId),
          context,
        )
      if (native?.type !== "input" || native.status !== "done")
        throw new Error("Missing persisted formal answer")
      expect(await parent(f.owner(), saved.conversationId)).toEqual({
        conversationId: source.conversationId,
        at: native.answer,
      })
      expect(requestText(f.pi, 2)).toContain("Persisted pending article source")
      expect(requestText(f.pi, 2)).toContain("Persisted formal answer")
      expect(requestText(f.pi, 2)).not.toMatch(/WRONG|progress-not-source|正在處理/)
      expect(f.pi.pendingReplies).toBe(0)
    } finally {
      await telegram.stop()
    }
  }, 20_000)

  it.each(["cancel", "reset"] as const)(
    "%s stops every child and pending dependency without affecting a peer chat",
    async (command) => {
      const f = await setup()
      const seed = await f.answer("Lifecycle seed", 10)
      await f.registry.recordDelivery(-100, checkpoint(seed), [110])
      const rootId = f.owner().sessionId
      const active: Array<{
        result: Promise<SubmissionResult>
        release: () => void
        source: number
      }> = []
      for (const [i, routing] of (["main", "article", "reply"] as const).entries()) {
        const release = f.pause()
        const result = f.submit(`Lifecycle blocked ${routing}`, {
          routing,
          replyToMessageId: 110,
          delivery: delivery(20 + i),
        })
        active.push({ result, release, source: 20 + i })
        await requests(f.pi, i + 2)
      }
      const records = await pending(f.owner())
      const releasePending = f.registry.trackPendingInput(-100, 80, 1080)
      const waiting = f.submit("Lifecycle pending dependency", {
        routing: "reply",
        replyToMessageId: 1080,
        delivery: delivery(81),
      })
      const releasePeer = f.pause()
      const peer = f.submit(
        "Peer must survive",
        { routing: "article", delivery: delivery(90) },
        123,
      )
      await requests(f.pi, 5)
      const peerId = f.owner(123).sessionId
      await f.registry[command](-100)
      await vi.waitFor(() => expect(f.pi.disconnectedRequests).toBe(3))
      releasePending()
      for (const item of active) item.release()
      const results = await Promise.allSettled([...active.map((item) => item.result), waiting])
      expect(results.at(-1)).toMatchObject({ status: "rejected", reason: { name: "AbortError" } })
      for (const result of results.slice(0, 3)) {
        expect(result).toMatchObject({
          status: "fulfilled",
          value: { kind: "no_response", settlement: { status: "unanswered", reason: "aborted" } },
        })
      }
      if (command === "cancel") {
        expect(await pending(f.owner())).toEqual([])
        for (const record of records)
          expect(
            await f
              .owner()
              .harness.commit(
                (tx) => tx.submissionByRequest(record.conversationId, record.requestId),
                context,
              ),
          ).toMatchObject({ status: "unanswered", reason: "aborted" })
      }
      expect(f.owner(123).sessionId).toBe(peerId)
      expect(f.owner(123).isStreaming).toBe(true)
      expect(await pending(f.owner(123))).toHaveLength(1)
      expect(f.pi.disconnectedRequests).toBe(3)
      f.pi.enqueueAnswer("Peer survived answer")
      releasePeer()
      await assertOwned(f.owner(123), await peer, 90)
      if (command === "reset") {
        await f.answer("Fresh after reset", 100, {
          routing: "reply",
          replyToMessageId: 110,
          unresolvedReplyPrompt: "Fresh reset fallback",
        })
        expect(f.owner().sessionId).not.toBe(rootId)
        expect(requestText(f.pi, 5)).toContain("Fresh reset fallback")
        expect(requestText(f.pi, 5)).not.toContain("Lifecycle seed")
        expect((await pending(f.owner())).map((item) => item.delivery.sourceMessageId)).toEqual([
          100,
        ])
      } else {
        expect(f.owner().sessionId).toBe(rootId)
        const restored = await f.answer("Valid reply after cancel", 100, {
          routing: "reply",
          replyToMessageId: 110,
        })
        expect(
          await parent(f.owner(), (await recordFor(f.owner(), 100)).conversationId),
        ).toBeDefined()
        expect(restored.kind).toBe("completed")
      }
    },
  )

  it("releases an admitted passive reply dependency when policies invalidate its blocked owner", async () => {
    const f = await setup()
    const release = f.pause()
    const main = f.submit("Blocked main before policy invalidation", {
      routing: "main",
      delivery: delivery(10),
    })
    await requests(f.pi, 1)
    const oldOwner = f.owner()
    await f.registry.appendPassiveContext(-100, "Passive source admitted before invalidation", 40)
    await within(f.registry.invalidatePolicies(), "policy invalidation with a queued passive write")
    await vi.waitFor(() => expect(f.pi.disconnectedRequests).toBe(1))
    release()
    await within(main, "invalidated main settlement")
    const releaseReply = f.pause()
    const reply = f.submit("Reply after policy invalidation", {
      routing: "reply",
      replyToMessageId: 40,
      delivery: delivery(50),
      unresolvedReplyPrompt: "Bounded passive context after policy invalidation",
    })
    // Do not queue a fixture response until the old dependency has released.
    await requests(f.pi, 2)
    f.pi.enqueueAnswer("Answer: Reply after policy invalidation")
    releaseReply()
    const result = await within(reply, "reply must not await old passive PendingInput")
    expect(f.owner()).not.toBe(oldOwner)
    expect(f.owner().sessionId).toBe(oldOwner.sessionId)
    expect(result).toMatchObject({
      kind: "completed",
      text: "Answer: Reply after policy invalidation",
    })
    const saved = await assertOwned(f.owner(), result, 50)
    expect(saved.conversationId).not.toBe(f.owner().conversationId)
    expect(requestText(f.pi, 1)).toMatch(/Passive source admitted|Bounded passive context/)
    expect(f.pi.requests).toHaveLength(2)
    expect(f.pi.pendingReplies).toBe(0)
  }, 15_000)

  it("recovers a passive native checkpoint after index loss without using a later main head", async () => {
    const f = await setup()
    const seed = await f.answer("Passive recovery seed", 10)
    await f.registry.recordDelivery(-100, checkpoint(seed), [110])
    const failedIndex = vi
      .spyOn(TelegramReplyIndex.prototype, "record")
      .mockRejectedValueOnce(new Error("Offline index write failed"))
    try {
      await f.registry.appendPassiveContext(-100, "Passive durable source", 40)
      await f.owner().waitForIdle()
      await vi.waitFor(() => expect(failedIndex).toHaveBeenCalled())
    } finally {
      failedIndex.mockRestore()
    }
    const source = f.owner().getCheckpoint()
    if (!source) throw new Error("Missing passive native checkpoint")
    const later = await f.answer("FORBIDDEN later main history", 50)
    await f.registry.recordDelivery(-100, checkpoint(later), [150])
    await f.registry.appendPassiveContext(-100, "FORBIDDEN later passive history", 51)
    await f.owner().waitForIdle()
    await f.registry.dispose()
    await new TelegramReplyIndex(
      f.pi.settings.botSessionLogDir,
      1_000,
      1_000_000,
      f.pi.logger,
    ).clear(-100)
    await f.reopen()
    const result = await f.answer("Reply to recovered passive", 60, {
      routing: "reply",
      replyToMessageId: 40,
      unresolvedReplyPrompt: "WRONG passive fallback",
    })
    const saved = await assertOwned(f.owner(), result, 60)
    const [conversationId, at] = source.split(":").map(Number)
    expect(await parent(f.owner(), saved.conversationId)).toEqual({ conversationId, at })
    expect(requestText(f.pi, 2)).toContain("Passive durable source")
    expect(requestText(f.pi, 2)).not.toMatch(/FORBIDDEN|WRONG passive fallback/)
    expect(f.owner().conversationId).toBe(conversationId)
  })

  it("keeps same-source siblings independent while one sibling is still running", async () => {
    const f = await setup()
    const seed = await f.answer("Sibling source", 10)
    await f.registry.recordDelivery(-100, checkpoint(seed), [110])
    const release = f.pause()
    const first = f.submit("Blocked sibling question", {
      routing: "reply",
      replyToMessageId: 110,
      delivery: delivery(20),
    })
    await requests(f.pi, 2)
    const second = await f.answer("Independent sibling question", 30, {
      routing: "reply",
      replyToMessageId: 110,
    })
    const secondRecord = await assertOwned(f.owner(), second, 30)
    const firstRecord = await recordFor(f.owner(), 20)
    expect(firstRecord.conversationId).not.toBe(secondRecord.conversationId)
    expect(await parent(f.owner(), firstRecord.conversationId)).toEqual(
      await parent(f.owner(), secondRecord.conversationId),
    )
    expect(requestText(f.pi, 2)).not.toContain("Blocked sibling question")
    expect((await recordFor(f.owner(), 20)).answerEntryId).toBeUndefined()
    f.pi.enqueueAnswer("First sibling owned answer")
    release()
    await assertOwned(f.owner(), await first, 20)
    expect(await transcript(f.owner(), firstRecord.conversationId)).not.toContain(
      "Independent sibling question",
    )
    expect(await transcript(f.owner(), secondRecord.conversationId)).not.toContain(
      "First sibling owned answer",
    )
  })

  it("queues main requests in arrival order without steering or delaying an independent article", async () => {
    const f = await setup()
    const releaseFirst = f.pause()
    const first = f.submit("First main input", { routing: "main", delivery: delivery(10) })
    await requests(f.pi, 1)
    const acceptedSecond = vi.fn()
    const second = f.submit("Second main input", {
      routing: "main",
      delivery: delivery(20),
      onAccepted: acceptedSecond,
    })
    const article = await f.answer("Independent article input", 30, { routing: "article" })
    expect(article.kind).toBe("completed")
    expect(acceptedSecond).not.toHaveBeenCalled()
    expect((await pending(f.owner())).map((item) => item.delivery.sourceMessageId).sort()).toEqual([
      10, 30,
    ])
    const releaseSecond = f.pause()
    f.pi.enqueueAnswer("First main owned answer")
    releaseFirst()
    const firstResult = await first
    expect(firstResult.text).toBe("First main owned answer")
    await assertOwned(f.owner(), firstResult, 10)
    await requests(f.pi, 3)
    expect(acceptedSecond).toHaveBeenCalledOnce()
    expect(requestText(f.pi, 0)).not.toContain("Second main input")
    expect(requestText(f.pi, 2)).toContain("First main owned answer")
    expect(requestText(f.pi, 2)).not.toContain("Independent article input")
    f.pi.enqueueAnswer("Second main owned answer")
    releaseSecond()
    const secondResult = await second
    expect(secondResult.text).toBe("Second main owned answer")
    await assertOwned(f.owner(), secondResult, 20)
    expect((await recordFor(f.owner(), 10)).conversationId).toBe(
      (await recordFor(f.owner(), 20)).conversationId,
    )
    expect(checkpoint(firstResult).entryId).not.toBe(checkpoint(secondResult).entryId)
  })

  it("creates two fresh article conversations without main, passive, or other article history", async () => {
    const f = await setup()
    await f.answer("Main secret marker", 10)
    await f.registry.appendPassiveContext(-100, "Passive secret marker", 11)
    const first = await f.answer("Article first source", 20, {
      routing: "article",
      delivery: delivery(20, "publish"),
    })
    const second = await f.answer("Article second source", 30, {
      routing: "article",
      delivery: delivery(30, "publish"),
      replyToMessageId: 10,
    })
    const one = await assertOwned(f.owner(), first, 20)
    const two = await assertOwned(f.owner(), second, 30)
    expect(one.conversationId).not.toBe(two.conversationId)
    for (const item of [one, two]) {
      expect(item.conversationId).not.toBe(f.owner().conversationId)
      expect(await parent(f.owner(), item.conversationId)).toBeUndefined()
      expect(
        await f.owner().harness.snapshot(ConversationPurposeDoc, item.conversationId, context),
      ).toEqual({ purpose: "article" })
    }
    expect(requestText(f.pi, 1)).not.toMatch(
      /Main secret marker|Passive secret marker|Article second source/,
    )
    expect(requestText(f.pi, 2)).not.toMatch(
      /Main secret marker|Passive secret marker|Article first source/,
    )
  })

  it("forks bot, user, branch, article, and passive checkpoints without moving main or copying its later tail", async () => {
    const f = await setup()
    const mainAnswer = await f.answer("Main origin", 10)
    const mainRecord = await recordFor(f.owner(), 10)
    await f.registry.recordDelivery(-100, checkpoint(mainAnswer), [110])
    const branchAnswer = await f.answer("Branch origin", 20, {
      routing: "reply",
      replyToMessageId: 110,
    })
    await f.registry.recordDelivery(-100, checkpoint(branchAnswer), [120])
    const articleAnswer = await f.answer("Article origin", 30, { routing: "article" })
    await f.registry.recordDelivery(-100, checkpoint(articleAnswer), [130])
    await f.registry.appendPassiveContext(-100, "Passive checkpoint origin", 40)
    const index = () =>
      new TelegramReplyIndex(f.pi.settings.botSessionLogDir, 1_000, 1_000_000, f.pi.logger)
    await vi.waitFor(async () => expect(await index().resolve(-100, 40)).toBeDefined())
    await f.registry.appendPassiveContext(-100, "FORBIDDEN later passive tail", 41)
    const main = f.owner().conversationId
    const nativeMain = await f
      .owner()
      .harness.commit(
        (tx) => tx.submissionByRequest(mainRecord.conversationId, mainRecord.requestId),
        context,
      )
    if (!nativeMain?.entry) throw new Error("Missing main input")
    const targets = [
      { message: 110, entry: checkpoint(mainAnswer).entryId },
      { message: 10, entry: `${main}:${nativeMain.entry}` },
      { message: 120, entry: checkpoint(branchAnswer).entryId },
      { message: 130, entry: checkpoint(articleAnswer).entryId },
      { message: 40, entry: (await index().resolve(-100, 40))?.entryId },
      { message: 110, entry: checkpoint(mainAnswer).entryId },
    ]
    const children: number[] = []
    for (const [i, target] of targets.entries()) {
      const question = `Isolated reply ${i}`
      const result = await f.answer(question, 50 + i, {
        routing: "reply",
        replyToMessageId: target.message,
      })
      const saved = await assertOwned(f.owner(), result, 50 + i)
      children.push(saved.conversationId)
      const [conversationId, at] = (target.entry ?? "").split(":").map(Number)
      expect(await parent(f.owner(), saved.conversationId)).toEqual({ conversationId, at })
      const actual = requestText(f.pi, 3 + 2 * i)
      expect(actual).not.toContain("FORBIDDEN later passive tail")
      for (let prior = 0; prior < i; prior++)
        expect(actual).not.toContain(`Isolated reply ${prior}`)
      if (target.message === 10) expect(actual).not.toContain("Answer: Main origin")
      const nextMain = await f.answer(`Main continues ${i}`, 200 + i)
      expect((await recordFor(f.owner(), 200 + i)).conversationId).toBe(main)
      expect(nextMain.kind).toBe("completed")
      expect(await f.owner().harness.snapshot(BotSessionDoc, context)).toMatchObject({
        mainConversation: main,
        activeConversation: main,
      })
    }
    expect(new Set(children).size).toBe(targets.length)
    expect(await transcript(f.owner(), main)).not.toContain("Isolated reply")
  })
})
