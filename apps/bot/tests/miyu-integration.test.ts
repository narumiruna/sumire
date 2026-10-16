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
  const member = vi.spyOn(api, "getChatMember").mockResolvedValue({ status: "member", user: miyu })
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

    member.mockResolvedValue({ status: "member", user: miyu })
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
      { ...fixture.settings, botToken: "123:fixture", botMaxConsecutiveRepliesToBots: 0 },
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
      const response = telegram.bot.handleUpdate(reply)
      // Telegram can deliver the update before the sendMessage HTTP response.
      finishSend(message(10, "request"))
      await response
      await turn
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

  it.each([
    { intent: "steer", action: "abort" },
    { intent: "followUp", action: "abort" },
    { intent: "steer", action: "dispose" },
    { intent: "followUp", action: "dispose" },
  ] as const)(
    "rejects $intent after $action during membership refresh",
    async ({ intent, action }) => {
      const { fixture, member, send } = await setup()
      const session = await fixture.createSession(-100)
      fixture.enqueue("miyu_cna_news", { query: "news" }, false)
      const turn = session.prompt("Start the news request").catch(() => undefined)
      let release = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      try {
        await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
        let entered = false
        member.mockImplementationOnce(async () => {
          entered = true
          await gate
          return { status: "member", user: miyu }
        })
        const queued = session[intent]("This input must be cancelled")
        const outcome = expect(queued).rejects.toThrow("cancelled before acceptance")
        await vi.waitFor(() => expect(entered).toBe(true))
        await session[action]()
        release()
        await outcome
        await turn
        expect(fixture.requests).toHaveLength(1)
        expect(JSON.stringify(session.messages)).not.toContain("This input must be cancelled")
      } finally {
        release()
        await session.abort()
        await turn
      }
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
