import { afterEach, describe, expect, it, vi } from "vitest"
import { MiyuCnaNews, type MiyuMessage, type MiyuTransport } from "../src/index.js"

const group = { id: -100123, type: "supergroup" }
function reply(overrides: Partial<MiyuMessage> = {}): MiyuMessage {
  return {
    chat: { id: group.id },
    message_id: 11,
    from: { is_bot: true, username: "miyuyo_bot" },
    text: "CNA news result",
    reply_to_message: { message_id: 10 },
    ...overrides,
  }
}
function createClient(transport: Pick<MiyuTransport, "sendMessage"> & Partial<MiyuTransport>) {
  return new MiyuCnaNews({ hasMiyuyoBot: async () => true, ...transport })
}
async function invoke(
  client: MiyuCnaNews,
  signal?: AbortSignal,
  chat = group,
  query = "今日台灣重要新聞",
) {
  const tool = await client.createTool(chat, signal)
  if (!tool) throw new Error("Tool is unavailable")
  return tool.execute("call-1", { query }, signal, undefined, undefined as never)
}
async function flush() {
  for (let i = 0; i < 15; i++) await Promise.resolve()
}
afterEach(() => vi.useRealTimers())

describe("miyu_cna_news", () => {
  it("posts the query to the bound group and returns the matching reply", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 10 })
    const client = createClient({ sendMessage })
    expect((await client.createTool(group))?.name).toBe("miyu_cna_news")
    const result = invoke(client)
    await flush()
    expect(sendMessage).toHaveBeenCalledWith(
      group.id,
      "@miyuyo_bot 使用 CNA MCP 今日台灣重要新聞",
      expect.any(AbortSignal),
    )
    expect(await client.handleMessage(reply())).toBe(true)
    expect((await result).details).toEqual({
      chatId: group.id,
      messageId: 11,
      text: "CNA news result",
    })
    expect(await client.handleMessage(reply())).toBe(false)
  })

  it("does not provide a tool when Miyu membership is absent or unknown", async () => {
    const sendMessage = vi.fn()
    const hasMiyuyoBot = vi.fn().mockResolvedValue(false)
    const client = createClient({ sendMessage, hasMiyuyoBot })
    expect(await client.createTool(group)).toBeUndefined()
    expect(hasMiyuyoBot).toHaveBeenCalledWith(group.id, undefined)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("does not provide a tool outside a group or check membership there", async () => {
    const sendMessage = vi.fn()
    const hasMiyuyoBot = vi.fn()
    const client = createClient({ sendMessage, hasMiyuyoBot })
    expect(await client.createTool({ id: 1, type: "private" })).toBeUndefined()
    expect(await client.createTool({ id: -1, type: "channel" })).toBeUndefined()
    expect(hasMiyuyoBot).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("rechecks membership before sending and refuses if Miyu left", async () => {
    const sendMessage = vi.fn()
    const hasMiyuyoBot = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
    const client = createClient({ sendMessage, hasMiyuyoBot })
    await expect(invoke(client)).rejects.toThrow("not a confirmed member")
    expect(sendMessage).not.toHaveBeenCalled()
    expect(await client.handleMessage(reply())).toBe(false)
  })

  it("fails closed when the membership check fails", async () => {
    const sendMessage = vi.fn()
    const client = createClient({
      sendMessage,
      hasMiyuyoBot: vi.fn().mockRejectedValue(new Error("membership unavailable")),
    })
    await expect(client.createTool(group)).rejects.toThrow("membership unavailable")
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("ignores other chats, users, bots, anonymous senders, empty text and unrelated replies", async () => {
    const client = createClient({ sendMessage: vi.fn().mockResolvedValue({ message_id: 10 }) })
    const result = invoke(client)
    await flush()
    for (const message of [
      reply({ chat: { id: -999 } }),
      reply({ from: { is_bot: false, username: "miyuyo_bot" } }),
      reply({ from: { is_bot: true, username: "other_bot" } }),
      reply({ sender_chat: { id: group.id } }),
      reply({ text: " " }),
      reply({ reply_to_message: undefined }),
      reply({ reply_to_message: { message_id: 99 } }),
    ])
      expect(await client.handleMessage(message)).toBe(false)
    expect(
      await client.handleMessage(reply({ from: { is_bot: true, username: "Miyuyo_Bot" } })),
    ).toBe(true)
    await result
  })

  it("retains a reply received before sendMessage resolves", async () => {
    const client = createClient({
      sendMessage: async () => {
        client.handleMessage(reply())
        return { message_id: 10 }
      },
    })
    expect((await invoke(client)).details.text).toBe("CNA news result")
  })

  it("matches early replies only after the sent request ID is known", async () => {
    let finishSend = (_sent: { message_id: number }) => {}
    const client = createClient({
      sendMessage: () =>
        new Promise((resolve) => {
          finishSend = resolve
        }),
    })
    const result = invoke(client)
    await flush()
    const unrelated = client.handleMessage(reply({ reply_to_message: { message_id: 99 } }))
    const matching = client.handleMessage(reply())
    finishSend({ message_id: 10 })
    expect(await unrelated).toBe(false)
    expect(await matching).toBe(true)
    await result
  })

  it("releases early reply routing when sending is cancelled", async () => {
    const client = createClient({ sendMessage: () => new Promise(() => {}) })
    const controller = new AbortController()
    const result = expect(invoke(client, controller.signal)).rejects.toThrow("cancelled")
    await flush()
    const handled = client.handleMessage(reply())
    controller.abort(new Error("cancelled"))
    await result
    expect(await handled).toBe(false)
  })

  it("rejects empty queries without sending", async () => {
    const sendMessage = vi.fn()
    const client = createClient({ sendMessage })
    await expect(invoke(client, undefined, group, " ")).rejects.toThrow("Invalid news query")
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("rejects concurrent requests in one group but permits independent groups", async () => {
    const client = createClient({ sendMessage: vi.fn().mockResolvedValue({ message_id: 10 }) })
    const first = invoke(client)
    await expect(invoke(client)).rejects.toThrow("already pending")
    const second = invoke(client, undefined, { ...group, id: -456 })
    await flush()
    expect(await client.handleMessage(reply({ chat: { id: -456 } }))).toBe(true)
    await second
    expect(await client.handleMessage(reply())).toBe(true)
    await first
  })

  it("cleans up after send failure and permits another request", async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("send failed"))
      .mockResolvedValue({ message_id: 10 })
    const client = createClient({ sendMessage })
    await expect(invoke(client)).rejects.toThrow("send failed")
    const result = invoke(client)
    await flush()
    client.handleMessage(reply())
    await result
  })

  it("times out even if the transport does not finish sending", async () => {
    vi.useFakeTimers()
    const client = createClient({ sendMessage: () => new Promise(() => {}) })
    const result = expect(invoke(client)).rejects.toThrow("Timed out")
    await vi.advanceTimersByTimeAsync(120_000)
    await result
    expect(await client.handleMessage(reply())).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("cancels waiting and aborts the transport signal", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ message_id: 10 })
    const client = createClient({ sendMessage })
    const controller = new AbortController()
    const result = invoke(client, controller.signal)
    const rejected = expect(result).rejects.toThrow("cancelled")
    await flush()
    controller.abort(new Error("cancelled"))
    await rejected
    expect(sendMessage.mock.calls[0]?.[2].aborted).toBe(true)
    expect(await client.handleMessage(reply())).toBe(false)
    const next = invoke(client)
    await flush()
    client.handleMessage(reply())
    await next
  })

  it("does not send when already cancelled", async () => {
    const sendMessage = vi.fn()
    const client = createClient({ sendMessage })
    await expect(invoke(client, AbortSignal.abort(new Error("cancelled")))).rejects.toThrow(
      "cancelled",
    )
    expect(sendMessage).not.toHaveBeenCalled()
  })
})
