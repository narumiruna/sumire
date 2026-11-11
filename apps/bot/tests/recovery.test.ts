import { Bot } from "grammy"
import { expect, it, vi } from "vitest"
import type { DurableAnswer } from "../src/agent/durable/outbox.js"
import type { ChatSessionRegistry } from "../src/agent/session-registry.js"
import type { Logger, SpanAttributes } from "../src/logging.js"
import { createTelegramDelivery } from "../src/telegram/delivery.js"
import { recoverTelegramResponses } from "../src/telegram/recovery.js"

function setup(media: boolean) {
  const spans: Array<{ name: string; attributes: SpanAttributes }> = []
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    async span(name, attributes, callback) {
      const record = { name, attributes: { ...attributes } }
      spans.push(record)
      return callback({
        setAttribute: (key, value) => {
          record.attributes[key] = value
        },
      })
    },
  }
  const bot = new Bot("123:synthetic")
  bot.botInfo = {} as never
  const methods: string[] = []
  bot.api.config.use(async (_previous, method) => {
    methods.push(method)
    return {
      ok: true,
      result: { message_id: 20 + methods.length, chat: { id: 123, type: "private" }, date: 0 },
    } as never
  })
  const answer: DurableAnswer = {
    text: "private recovered answer",
    requestId: "request",
    ...(media
      ? {
          media: [
            {
              id: "host-generated-receipt",
              extension: "png",
              mimeType: "image/png",
              byteLength: 4,
              width: 1,
              height: 1,
              sha256: "fixture",
              taskId: 1,
              callId: "call",
            },
          ],
        }
      : {}),
  }
  const checkpoint = { sessionId: "session", requestId: "request", entryId: "1:1", generation: 0 }
  let current = true
  const results: boolean[] = []
  const sessions = {
    recover: vi.fn<ChatSessionRegistry["recover"]>(async (_chatIds, deliver) => {
      results.push(
        await deliver(
          123,
          answer,
          { sourceMessageId: 10, mode: "default" },
          checkpoint,
          () => current,
        ),
      )
    }),
    assertResponseMediaAccess: vi.fn(async () => {}),
    readResponseImage: vi.fn(async () => Buffer.from("data")),
    recordResponseComponent: vi.fn(async () => {}),
    recordDelivery: vi.fn(async () => {}),
  }
  const delivery = createTelegramDelivery(
    {
      isConfigured: false,
      publish: async () => {
        throw new Error("unused")
      },
    },
    logger,
  )
  return {
    bot,
    sessions,
    delivery,
    logger,
    spans,
    methods,
    results,
    answer,
    cancel: () => {
      current = false
    },
  }
}

it.each([false, true])("records recovered delivery exactly once (media=%s)", async (media) => {
  const f = setup(media)
  await recoverTelegramResponses(f.bot, f.sessions, f.delivery, [123], f.logger)
  expect(f.results).toEqual([true])
  expect(f.methods).toEqual(media ? ["sendPhoto", "sendRichMessage"] : ["sendRichMessage"])
  expect(f.sessions.recordDelivery).toHaveBeenCalledOnce()
  const response = f.spans.find(({ name }) => name === "telegram.recover_response")
  expect(response?.attributes).toMatchObject({
    "operation.outcome": "delivered",
    "recovery.outcome": "delivered",
    "telegram.chat_id": 123,
    "telegram.message_id": 10,
    "pi.session_id": "session",
    "pi.request_id": "request",
  })
  expect(f.spans[0]?.attributes).toMatchObject({
    "operation.outcome": "scheduled",
    "recovery.outcome": "scheduled",
    "recovery.phase": "schedule",
  })
  if (media)
    expect(
      f.spans.find(({ name }) => name === "telegram.deliver")?.attributes["operation.outcome"],
    ).toBe("delivered")
  expect(JSON.stringify(f.spans)).not.toMatch(/private recovered answer|ZGF0YQ==|file_id/)
})

it.each([false, true])("records incomplete recovered delivery (media=%s)", async (media) => {
  const f = setup(media)
  vi.spyOn(f.delivery, "guardedReply").mockResolvedValueOnce({
    result: "unavailable",
    message: {
      message_id: 99,
      date: 0,
      chat: { id: 123, type: "private", first_name: "Fixture" },
      rich_message: { blocks: [] },
    },
  })
  await recoverTelegramResponses(f.bot, f.sessions, f.delivery, [123], f.logger)
  expect(f.results).toEqual([false])
  expect(f.sessions.recordDelivery).not.toHaveBeenCalled()
  expect(
    f.spans.find(({ name }) => name === "telegram.recover_response")?.attributes[
      "operation.outcome"
    ],
  ).toBe("incomplete")
  expect(f.methods).toEqual(media ? ["sendPhoto"] : [])
})

it.each([false, true])(
  "records cancelled recovered delivery with no effects (media=%s)",
  async (media) => {
    const f = setup(media)
    f.cancel()
    await recoverTelegramResponses(f.bot, f.sessions, f.delivery, [123], f.logger)
    expect(f.results).toEqual([false])
    expect(f.methods).toEqual([])
    expect(f.sessions.recordDelivery).not.toHaveBeenCalled()
    expect(
      f.spans.find(({ name }) => name === "telegram.recover_response")?.attributes[
        "operation.outcome"
      ],
    ).toBe("cancelled")
  },
)

it.each([false, true])(
  "preserves recovered errors without repeated delivery (media=%s)",
  async (media) => {
    const f = setup(media)
    const error = new Error("private upstream error payload")
    if (media) f.sessions.recordResponseComponent.mockRejectedValueOnce(error)
    else f.sessions.recordDelivery.mockRejectedValueOnce(error)
    await expect(
      recoverTelegramResponses(f.bot, f.sessions, f.delivery, [123], f.logger),
    ).rejects.toBe(error)
    expect(f.methods).toEqual(media ? ["sendPhoto"] : ["sendRichMessage"])
    expect(
      f.spans.find(({ name }) => name === "telegram.recover_response")?.attributes,
    ).toMatchObject({
      "operation.outcome": "error",
      "delivery.stage": media ? "media" : "ack",
    })
    expect(JSON.stringify(f.spans)).not.toContain("private upstream")
  },
)

it("does not wait for registry background work or perform another recovery", async () => {
  const f = setup(false)
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let background: Promise<boolean> | undefined
  f.sessions.recover.mockImplementationOnce(async (_chatIds, deliver) => {
    background = gate.then(() =>
      deliver(123, f.answer, { sourceMessageId: 10, mode: "default" }, undefined, () => true),
    )
  })
  await recoverTelegramResponses(f.bot, f.sessions, f.delivery, [123], f.logger)
  expect(f.methods).toEqual([])
  expect(f.spans[0]?.attributes["operation.outcome"]).toBe("scheduled")
  release()
  await expect(background).resolves.toBe(true)
  expect(f.methods).toEqual(["sendRichMessage"])
  expect(f.sessions.recover).toHaveBeenCalledOnce()
  expect(
    f.spans.find(({ name }) => name === "telegram.recover_response")?.attributes[
      "operation.outcome"
    ],
  ).toBe("delivered")
})
