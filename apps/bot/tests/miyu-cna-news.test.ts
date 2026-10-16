import { Api } from "grammy"
import type { Message, User } from "grammy/types"
import { describe, expect, it, vi } from "vitest"
import { TelegramMiyuNews } from "../src/telegram/miyu-cna-news.js"

const miyu: User = { id: 1234, is_bot: true, username: "miyuyo_bot", first_name: "Miyu" }
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const chat = { id: -100, type: "supergroup" as const, title: "News" }
function message(overrides: Partial<Message> = {}): Message {
  return { message_id: 20, date: 1, chat, from: miyu, text: "News result", ...overrides } as Message
}
function replied(messageId: number) {
  return { ...message({ message_id: messageId }), reply_to_message: undefined }
}
function setup() {
  const api = new Api("123:fixture")
  const getChat = vi
    .spyOn(api, "getChat")
    .mockResolvedValue(chat as Awaited<ReturnType<Api["getChat"]>>)
  const getChatAdministrators = vi.spyOn(api, "getChatAdministrators").mockResolvedValue([])
  const getChatMember = vi
    .spyOn(api, "getChatMember")
    .mockResolvedValue({ status: "administrator", user: miyu } as Awaited<
      ReturnType<Api["getChatMember"]>
    >)
  const sendMessage = vi
    .spyOn(api, "sendMessage")
    .mockResolvedValue({ ...message({ message_id: 10 }), text: "request" })
  const control = { allowsTool: vi.fn(() => true) }
  const client = new TelegramMiyuNews(api, control, logger)
  return { client, api, getChat, getChatAdministrators, getChatMember, sendMessage, control }
}
async function toolOf(client: TelegramMiyuNews) {
  const tool = await client.createTool(chat.id)
  if (!tool) throw new Error("Tool unavailable")
  return tool
}

describe("Telegram Miyu news transport", () => {
  it("discovers an existing administrator bot and checks its numeric membership", async () => {
    const f = setup()
    f.getChatAdministrators.mockResolvedValue([
      { status: "administrator", user: miyu } as Awaited<
        ReturnType<Api["getChatAdministrators"]>
      >[number],
    ])
    expect((await toolOf(f.client)).name).toBe("miyu_cna_news")
    expect(f.getChatAdministrators).toHaveBeenCalledWith(
      -100,
      { return_bots: true },
      expect.anything(),
    )
    expect(f.getChatMember).toHaveBeenCalledWith(-100, miyu.id, expect.anything())
  })

  it("does not offer the tool with unknown identity or absent membership", async () => {
    const f = setup()
    expect(await f.client.createTool(-100)).toBeUndefined()
    expect(f.getChatMember).not.toHaveBeenCalled()
    f.client.observe(message())
    f.getChatMember.mockResolvedValue({ status: "left", user: miyu })
    expect(await f.client.createTool(-100)).toBeUndefined()
    expect(f.sendMessage).not.toHaveBeenCalled()
  })

  it.each([
    { status: "member" as const, user: miyu },
    { status: "restricted" as const, user: miyu, is_member: true },
  ])("does not offer the tool for $status status", async (member) => {
    const f = setup()
    f.client.observe(message())
    f.getChatMember.mockResolvedValue(member as Awaited<ReturnType<Api["getChatMember"]>>)
    expect(await f.client.createTool(-100)).toBeUndefined()
    expect(f.sendMessage).not.toHaveBeenCalled()
  })

  it.each([
    { status: "member" as const, user: miyu },
    { status: "restricted" as const, user: miyu, is_member: true },
  ])("refuses a previously offered tool after demotion to $status", async (member) => {
    const f = setup()
    f.client.observe(message())
    const tool = await toolOf(f.client)
    f.getChatMember.mockResolvedValue(member as Awaited<ReturnType<Api["getChatMember"]>>)
    await expect(
      tool.execute("call", { query: "今日新聞" }, undefined, undefined, undefined as never),
    ).rejects.toThrow("not a confirmed member")
    expect(f.sendMessage).not.toHaveBeenCalled()
  })

  it("learns identities from service messages but verifies membership in the target group", async () => {
    const f = setup()
    f.client.observe(
      message({
        chat: { ...chat, id: -200 },
        from: { id: 8, is_bot: false, first_name: "Alice" },
        new_chat_members: [miyu],
      }),
    )
    await toolOf(f.client)
    expect(f.getChatMember).toHaveBeenCalledWith(-100, miyu.id, expect.anything())
    expect(f.getChatAdministrators).not.toHaveBeenCalled()
  })

  it("ignores usernames from humans and rejects a changed bot username", async () => {
    const f = setup()
    f.client.observe(message({ from: { ...miyu, is_bot: false } }))
    expect(await f.client.createTool(-100)).toBeUndefined()
    f.client.observe(message())
    f.getChatMember.mockResolvedValue({
      status: "member",
      user: { ...miyu, username: "another_bot" },
    })
    expect(await f.client.createTool(-100)).toBeUndefined()
  })

  it("skips private, channel, and unauthorized chats", async () => {
    const f = setup()
    expect(await f.client.createTool(7)).toBeUndefined()
    expect(f.getChat).not.toHaveBeenCalled()
    f.control.allowsTool.mockReturnValue(false)
    expect(await f.client.createTool(-100)).toBeUndefined()
    expect(f.getChat).not.toHaveBeenCalled()
    f.control.allowsTool.mockReturnValue(true)
    f.getChat.mockResolvedValue({ ...chat, type: "channel" } as Awaited<ReturnType<Api["getChat"]>>)
    expect(await f.client.createTool(-100)).toBeUndefined()
    expect(f.getChatAdministrators).not.toHaveBeenCalled()
  })

  it("fails closed on Telegram errors and uses a bounded signal", async () => {
    const f = setup()
    f.client.observe(message())
    f.getChatMember.mockRejectedValue(new Error("Telegram unavailable"))
    expect(await f.client.createTool(-100)).toBeUndefined()
    expect(f.getChatMember.mock.calls[0]?.[2]).toHaveProperty("aborted", false)
    expect(f.sendMessage).not.toHaveBeenCalled()
  })

  it("refuses a previously offered tool after Miyu leaves", async () => {
    const f = setup()
    f.client.observe(message())
    const tool = await toolOf(f.client)
    f.getChatMember.mockResolvedValue({ status: "left", user: miyu })
    await expect(
      tool.execute("call", { query: "今日新聞" }, undefined, undefined, undefined as never),
    ).rejects.toThrow("not a confirmed member")
    expect(f.sendMessage).not.toHaveBeenCalled()
  })

  it("refuses a previously offered tool after authorization is revoked", async () => {
    const f = setup()
    f.client.observe(message())
    const tool = await toolOf(f.client)
    f.control.allowsTool.mockReturnValue(false)
    await expect(
      tool.execute("call", { query: "今日新聞" }, undefined, undefined, undefined as never),
    ).rejects.toThrow()
    expect(f.sendMessage).not.toHaveBeenCalled()
  })

  it("sends and accepts only the direct Miyu reply in the authorized group", async () => {
    const f = setup()
    f.client.observe(message())
    const tool = await toolOf(f.client)
    const result = tool.execute(
      "call",
      { query: "今日新聞" },
      undefined,
      undefined,
      undefined as never,
    )
    await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledOnce())
    expect(f.sendMessage).toHaveBeenCalledWith(
      -100,
      "@miyuyo_bot 使用 CNA MCP 今日新聞",
      {},
      expect.anything(),
    )
    expect(await f.client.handleMessage(message({ reply_to_message: replied(99) }))).toBe(false)
    expect(await f.client.handleMessage(message({ reply_to_message: replied(10) }))).toBe(true)
    expect((await result).details.text).toBe("News result")
  })

  it("cancels the request without another model turn", async () => {
    const f = setup()
    f.client.observe(message())
    const tool = await toolOf(f.client)
    const controller = new AbortController()
    const result = tool.execute(
      "call",
      { query: "今日新聞" },
      controller.signal,
      undefined,
      undefined as never,
    )
    const rejected = expect(result).rejects.toThrow("cancelled")
    await vi.waitFor(() => expect(f.sendMessage).toHaveBeenCalledOnce())
    controller.abort(new Error("cancelled"))
    await rejected
    expect(f.sendMessage.mock.calls[0]?.[3]?.aborted).toBe(true)
    f.control.allowsTool.mockReturnValue(false)
    expect(await f.client.createTool(-100)).toBeUndefined()
    expect(await f.client.handleMessage(message({ reply_to_message: replied(10) }))).toBe(true)
    expect(await f.client.handleMessage(message({ reply_to_message: replied(99) }))).toBe(false)
    expect(
      await f.client.handleMessage(
        message({ from: { ...miyu, is_bot: false }, reply_to_message: replied(10) }),
      ),
    ).toBe(false)
  })
})
