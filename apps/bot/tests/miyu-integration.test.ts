import { Api } from "grammy"
import type { Message, Update, UserFromGetMe } from "grammy/types"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { createTelegramAgentBot } from "../src/telegram/bot.js"
import { TelegramMiyuNews } from "../src/telegram/miyu-cna-news.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

const fixtures: Awaited<ReturnType<typeof createPiFixture>>[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
})
const miyu = { id: 1234, is_bot: true, username: "miyuyo_bot", first_name: "Miyu" }
const chat = { id: -100, type: "supergroup" as const, title: "News" }
const administrator = { status: "administrator", user: miyu } as Awaited<
  ReturnType<Api["getChatMember"]>
>
const botInfo: UserFromGetMe = {
  id: 999,
  is_bot: true,
  first_name: "Sumire",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: true,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
}
function message(messageId: number, text: string) {
  return {
    message_id: messageId,
    date: 1_700_000_000,
    chat,
    from: miyu,
    text,
  } satisfies Message.TextMessage
}
async function setup() {
  let host: TelegramMiyuNews
  const fixture = await createPiFixture({}, { createTool: (chatId) => host.createTool(chatId) })
  fixtures.push(fixture)
  const api = new Api("123:fixture")
  vi.spyOn(api, "getChat").mockResolvedValue(chat as Awaited<ReturnType<Api["getChat"]>>)
  vi.spyOn(api, "getChatAdministrators").mockResolvedValue([])
  const member = vi.spyOn(api, "getChatMember").mockResolvedValue(administrator)
  const send = vi.spyOn(api, "sendMessage").mockResolvedValue(message(10, "request"))
  host = new TelegramMiyuNews(api, fixture.factory.control, fixture.logger)
  host.observe(message(1, "identity"))
  return { fixture, host, member, send }
}

describe("Miyu bot integration", () => {
  it("refreshes direct and codemode tools in an existing session after membership changes", async () => {
    const { fixture, member } = await setup()
    member.mockResolvedValue({ status: "left", user: miyu })
    const session = await fixture.createSession(-100)
    expect(fixture.factory.toolNames).toContain("miyu_cna_news")
    expect(session.getActiveToolNames()).not.toContain("miyu_cna_news")
    fixture.enqueueAnswer()
    await session.prompt("Check available tools")
    expect(fixture.requests.at(-1)?.tools.map((tool) => tool.function.name)).not.toContain(
      "miyu_cna_news",
    )

    member.mockResolvedValue(administrator)
    fixture.enqueueAnswer()
    await session.prompt("Check available tools again")
    expect(session.getActiveToolNames()).toContain("miyu_cna_news")
    expect(session.nativeTools.map((tool) => tool.name)).toContain("miyu_cna_news")
    expect(fixture.requests.at(-1)?.tools.map((tool) => tool.function.name)).toContain(
      "miyu_cna_news",
    )

    member.mockResolvedValue({ status: "left", user: miyu })
    fixture.enqueueAnswer()
    await session.prompt("Miyu left")
    expect(session.getActiveToolNames()).not.toContain("miyu_cna_news")
    expect(session.nativeTools.map((tool) => tool.name)).not.toContain("miyu_cna_news")
    expect(fixture.requests.at(-1)?.tools.map((tool) => tool.function.name)).not.toContain(
      "miyu_cna_news",
    )
    member.mockResolvedValue(administrator)
    fixture.enqueueAnswer()
    await session.prompt("Miyu is an administrator again")
    expect(session.getActiveToolNames()).toContain("miyu_cna_news")

    member.mockResolvedValue({ status: "member", user: miyu })
    fixture.enqueueAnswer()
    await session.prompt("Miyu is no longer an administrator")
    expect(session.getActiveToolNames()).not.toContain("miyu_cna_news")
    expect(session.nativeTools.map((tool) => tool.name)).not.toContain("miyu_cna_news")
    expect(fixture.requests.at(-1)?.tools.map((tool) => tool.function.name)).not.toContain(
      "miyu_cna_news",
    )
    await session.dispose()
    const reopened = await fixture.createSession(-100)
    expect(reopened.getActiveToolNames()).not.toContain("miyu_cna_news")
  })

  it("does not register or check membership for a tool denied by chat policy", async () => {
    const { fixture, member } = await setup()
    const store = fixture.factory.control
    const state = store.snapshot()
    state.policy.defaults.tools =
      state.policy.defaults.tools?.filter((name) => name !== "miyu_cna_news") ?? []
    store.save(state.policy, state.revision, "7")
    store.applied(state.revision + 1, true)
    const session = await fixture.createSession(-100)
    expect(session.getActiveToolNames()).not.toContain("miyu_cna_news")
    expect(member).not.toHaveBeenCalled()
  })

  it("routes an early Miyu reply to the waiting tool without a second submission or passive queue", async () => {
    const { fixture, host, send } = await setup()
    let finishSend = (_message: Message.TextMessage) => {}
    send.mockReturnValueOnce(
      new Promise<Message.TextMessage>((resolve) => {
        finishSend = resolve
      }),
    )
    const session = await fixture.createSession(-100)
    const sessions = new ChatSessionRegistry(
      async () => session,
      fixture.settings.botSessionLogDir,
      fixture.logger,
      { control: fixture.factory.control },
    )
    const submit = vi.spyOn(sessions, "submit")
    const passive = vi.spyOn(sessions, "appendPassiveContext")
    const telegram = createTelegramAgentBot(
      { ...fixture.settings, botToken: "123:fixture", botMaxConsecutiveRepliesToBots: 2 },
      sessions,
      fixture.logger,
      { botInfo, control: fixture.factory.control, miyuNews: host },
    )
    let id = 100
    telegram.bot.api.config.use(async (_previous, method, payload) => {
      if (method === "sendMessage")
        return {
          ok: true,
          result: message(id++, "text" in payload ? String(payload.text) : ""),
        } as never
      return { ok: true, result: true } as never
    })
    fixture.enqueue("miyu_cna_news", { query: "今日台灣重要新聞" })
    const user: Update = {
      update_id: 1,
      message: {
        ...message(2, "@test_bot 搜尋今日台灣新聞"),
        from: { id: 7, is_bot: false, first_name: "Alice" },
      },
    }
    const turn = telegram.bot.handleUpdate(user)
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
      const reply: Update = {
        update_id: 2,
        message: {
          ...message(20, "CNA verified fixture news"),
          reply_to_message: {
            ...message(10, "request"),
            from: botInfo,
            reply_to_message: undefined,
          },
        },
      }
      const nonText = telegram.bot.handleUpdate({
        update_id: 3,
        message: {
          ...message(19, ""),
          text: undefined,
          caption: "Miyu photo part",
          photo: [{ file_id: "photo", file_unique_id: "photo", width: 1, height: 1 }],
          reply_to_message: reply.message?.reply_to_message,
        },
      })
      // Telegram can deliver a non-text update before sendMessage returns its ID.
      finishSend(message(10, "request"))
      await nonText
      expect(submit).toHaveBeenCalledOnce()
      expect(session.messages).not.toContainEqual(
        expect.objectContaining({ role: "toolResult", toolName: "miyu_cna_news" }),
      )
      await telegram.bot.handleUpdate(reply)
      await turn
      // Later parts must not enter the ordinary addressed-message path either.
      await telegram.bot.handleUpdate({
        ...reply,
        update_id: 4,
        message: {
          ...message(21, "Miyu second text part"),
          reply_to_message: reply.message?.reply_to_message,
        },
      })
      expect(submit).toHaveBeenCalledOnce()
      expect(passive).not.toHaveBeenCalled()
      expect(session.messages).toContainEqual(
        expect.objectContaining({ role: "toolResult", toolName: "miyu_cna_news", isError: false }),
      )
      expect(JSON.stringify(fixture.requests.at(-1)?.messages)).toContain(
        "CNA verified fixture news",
      )
    } finally {
      await sessions.dispose()
      await turn
    }
  })

  it.each(["steer", "followUp"] as const)(
    "does not submit %s after cancellation during membership refresh",
    async (intent) => {
      const { fixture, member } = await setup()
      const session = await fixture.createSession(-100)
      const releaseModel = fixture.pauseNextRequest()
      fixture.enqueueAnswer("Unused answer")
      const active = session.prompt("first input")
      let finishRefresh = (_member: Awaited<ReturnType<Api["getChatMember"]>>) => {}
      try {
        await vi.waitFor(() => expect(fixture.requests).toHaveLength(1))
        member.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishRefresh = resolve
            }),
        )
        const calls = member.mock.calls.length
        const queued = session[intent]("cancelled queued input")
        await vi.waitFor(() => expect(member.mock.calls.length).toBe(calls + 1))
        await session.abort()
        finishRefresh(administrator)
        await queued
        await active
        await session.waitForIdle()
        expect(fixture.requests).toHaveLength(1)
        expect(JSON.stringify(session.messages)).not.toContain("cancelled queued input")
      } finally {
        finishRefresh(administrator)
        releaseModel()
        await session.abort()
        await active
      }
    },
  )

  it.each(["steer", "followUp"] as const)(
    "does not submit %s after disposal during membership refresh",
    async (intent) => {
      const { fixture, member } = await setup()
      const session = await fixture.createSession(-100)
      let finishRefresh = (_member: Awaited<ReturnType<Api["getChatMember"]>>) => {}
      member.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRefresh = resolve
          }),
      )
      const calls = member.mock.calls.length
      const queued = session[intent]("closed queued input")
      try {
        await vi.waitFor(() => expect(member.mock.calls.length).toBe(calls + 1))
        await session.dispose()
      } finally {
        finishRefresh(administrator)
      }
      await expect(queued).resolves.toBe("queued")
      expect(fixture.requests).toHaveLength(0)
      expect(JSON.stringify(session.messages)).not.toContain("closed queued input")
    },
  )

  it("never routes Miyu messages from an unauthorized chat", async () => {
    const { fixture } = await setup()
    const sessions = {
      submit: vi.fn(),
      appendPassiveContext: vi.fn(),
    } as unknown as ChatSessionRegistry
    const bridge = { observe: vi.fn(), handleMessage: vi.fn(async () => true) }
    const telegram = createTelegramAgentBot(
      { ...fixture.settings, botToken: "123:fixture" },
      sessions,
      fixture.logger,
      { botInfo, control: fixture.factory.control, miyuNews: bridge },
    )
    await telegram.bot.handleUpdate({
      update_id: 1,
      message: { ...message(1, "reply"), chat: { ...chat, id: -999 } },
    })
    expect(bridge.observe).not.toHaveBeenCalled()
    expect(bridge.handleMessage).not.toHaveBeenCalled()
    expect(sessions.submit).not.toHaveBeenCalled()
  })
})
