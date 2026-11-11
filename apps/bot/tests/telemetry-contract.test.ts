import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import * as logfire from "@pydantic/logfire-node"
import { type Api, Bot, type Context } from "grammy"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { GeneratedMedia } from "../src/agent/durable/media.js"
import { OutboxDoc } from "../src/agent/durable/state.js"
import { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { createLogger, type LogfireClient } from "../src/logging.js"
import { createTelegramDelivery } from "../src/telegram/delivery.js"
import { downloadTelegramFile, TelegramDownloadTooLargeError } from "../src/telegram/files.js"
import { deliverGeneratedResponse } from "../src/telegram/media-delivery.js"
import { recoverTelegramResponses } from "../src/telegram/recovery.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

type CapturedSpan = {
  name: string
  attributes: Record<string, unknown>
  status: { code: number }
}
const loggers: ReturnType<typeof createLogger>[] = []
afterEach(async () => {
  for (const logger of loggers.splice(0)) await logger.shutdown?.()
  vi.restoreAllMocks()
})

function offlineLogger() {
  const spans: CapturedSpan[] = []
  const client: LogfireClient = {
    ...logfire,
    configure(options) {
      logfire.configure({
        ...options,
        sendToLogfire: false,
        metrics: false,
        variables: false,
        apiKey: "",
        minLevel: null,
        sampling: { head: 1 },
        advanced: { pendingSpans: false },
        additionalSpanProcessors: [
          {
            onStart() {},
            onEnd(span) {
              spans.push({
                name: span.name,
                attributes: { ...span.attributes },
                status: { ...span.status },
              })
            },
            async forceFlush() {},
            async shutdown() {},
          },
        ],
      })
    },
  }
  const logger = createLogger(false, "offline-fixture", client)
  loggers.push(logger)
  return { logger, spans }
}

function fileApi(): Api {
  return {
    getFile: vi.fn(async () => ({
      file_id: "private-file-id",
      file_unique_id: "unique",
      file_path: "private-file-path",
    })),
  } as unknown as Api
}

function assertNoPayload(spans: CapturedSpan[]) {
  const output = JSON.stringify(spans)
  for (const value of [
    "private-file-id",
    "private-file-path",
    "private-token",
    "private-response",
    "api.telegram.org",
    "fixture-image-bytes",
  ])
    expect(output).not.toContain(value)
}

describe("real SDK contracts across telemetry producers", () => {
  it.each(["acknowledged", "pending"] as const)(
    "records actual registry acknowledgement as %s without repeating delivered work",
    async (outcome) => {
      const { logger, spans } = offlineLogger()
      const fixture = await createPiFixture()
      const session = await fixture.createSession()
      const registry = new ChatSessionRegistry(
        async () => session,
        fixture.settings.botSessionLogDir,
        logger,
        { control: fixture.factory.control },
      )
      const failure = Object.assign(new Error("private-response"), { code: "SQLITE_BUSY" })
      const acknowledge = vi.spyOn(session, "acknowledge")
      if (outcome === "pending") acknowledge.mockRejectedValue(failure)
      try {
        fixture.enqueueAnswer("private-response")
        const result = await registry.submit(123, "private-input", {
          delivery: { sourceMessageId: 10, mode: "default" },
        })
        if (result.kind !== "completed" || !result.checkpoint)
          throw new Error("Missing fixture checkpoint")
        await expect(registry.recordDelivery(123, result.checkpoint, [20])).resolves.toBeUndefined()
        expect(acknowledge).toHaveBeenCalledOnce()
        expect(fixture.requests).toHaveLength(1)
        expect((await session.harness.snapshot(OutboxDoc, context))?.pending).toHaveLength(
          outcome === "pending" ? 1 : 0,
        )
        const ack = spans.find(({ name }) => name === "telegram.acknowledge")
        expect(ack?.attributes).toMatchObject({
          "telegram.chat_id": 123,
          "pi.session_id": session.sessionId,
          "pi.request_id": result.checkpoint.requestId,
          "delivery.stage": "ack",
          "delivery.outcome": outcome,
        })
        expect(ack?.status.code).toBe(outcome === "pending" ? 2 : 0)
        if (outcome === "pending") expect(ack?.attributes["error.code"]).toBe("SQLITE_BUSY")
        assertNoPayload(spans)
      } finally {
        acknowledge.mockRestore()
        await registry.dispose()
        await fixture.cleanup()
      }
    },
  )

  it("reports final recovery acknowledgement at its real owner after transport completes", async () => {
    const { logger, spans } = offlineLogger()
    const fixture = await createPiFixture()
    const session = await fixture.createSession()
    const registry = new ChatSessionRegistry(
      async () => session,
      fixture.settings.botSessionLogDir,
      logger,
      { control: fixture.factory.control },
    )
    const failure = Object.assign(new Error("private-response"), { code: "SQLITE_BUSY" })
    const acknowledge = vi.spyOn(session, "acknowledge").mockRejectedValue(failure)
    const bot = new Bot("123456:private-token")
    bot.botInfo = {} as never
    const methods: string[] = []
    bot.api.config.use(async (_previous, method) => {
      methods.push(method)
      return {
        ok: true,
        result: { message_id: 20, date: 0, chat: { id: 123, type: "private" } },
      } as never
    })
    const delivery = createTelegramDelivery(
      {
        isConfigured: false,
        publish: async () => {
          throw new Error("unused")
        },
      },
      logger,
    )
    try {
      fixture.enqueueAnswer("private-response")
      const answer = await session.prompt("private-input", {
        delivery: { sourceMessageId: 10, mode: "default" },
      })
      await recoverTelegramResponses(bot, registry, delivery, [123], logger)
      await vi.waitFor(() =>
        expect(spans.filter(({ name }) => name === "telegram.acknowledge")).toHaveLength(2),
      )
      await vi.waitFor(() =>
        expect(
          spans.some(({ attributes }) => attributes["event.name"] === "pi.recovery.failed"),
        ).toBe(true),
      )
      expect(methods).toEqual(["sendRichMessage"])
      expect(acknowledge).toHaveBeenCalledTimes(2)
      expect(fixture.requests).toHaveLength(1)
      expect((await session.harness.snapshot(OutboxDoc, context))?.pending).toHaveLength(1)
      const response = spans.find(({ name }) => name === "telegram.recover_response")
      expect(response?.attributes).toMatchObject({
        "recovery.outcome": "delivered",
        "pi.request_id": answer.requestId,
      })
      for (const ack of spans.filter(({ name }) => name === "telegram.acknowledge")) {
        expect(ack.attributes).toMatchObject({
          "pi.request_id": answer.requestId,
          "delivery.stage": "ack",
          "delivery.outcome": "pending",
          "error.code": "SQLITE_BUSY",
        })
        expect(ack.status.code).toBe(2)
      }
      assertNoPayload(spans)
    } finally {
      acknowledge.mockRestore()
      await registry.dispose()
      await fixture.cleanup()
    }
  })

  it("does not claim acknowledgement when delivery overlaps native session shutdown", async () => {
    const { logger, spans } = offlineLogger()
    const fixture = await createPiFixture()
    const session = await fixture.createSession()
    const registry = new ChatSessionRegistry(
      async () => session,
      fixture.settings.botSessionLogDir,
      logger,
      { control: fixture.factory.control, replyTreeEnabled: true },
    )
    let releaseCheckpoint = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve
    })
    const hasCheckpoint = vi.spyOn(session, "hasCheckpoint").mockImplementationOnce(async () => {
      await gate
      return false
    })
    const acknowledge = vi.spyOn(session, "acknowledge")
    let recording: Promise<void> | undefined
    try {
      fixture.enqueueAnswer("private-response")
      const result = await registry.submit(123, "private-input", {
        delivery: { sourceMessageId: 10, mode: "default" },
      })
      if (result.kind !== "completed" || !result.checkpoint)
        throw new Error("Missing fixture checkpoint")
      recording = registry.recordDelivery(123, result.checkpoint, [20])
      await vi.waitFor(() => expect(hasCheckpoint).toHaveBeenCalledOnce())
      await registry.dispose()
      releaseCheckpoint()
      await recording
      expect(acknowledge).toHaveBeenCalledOnce()
      const ack = spans.find(({ name }) => name === "telegram.acknowledge")
      expect(ack?.attributes).toMatchObject({
        "delivery.outcome": "cancelled",
        "operation.outcome": "cancelled",
      })
      expect(ack?.status.code).toBe(0)
      const reopened = await fixture.createSession()
      expect((await reopened.harness.snapshot(OutboxDoc, context))?.pending).toHaveLength(1)
      expect(fixture.requests).toHaveLength(1)
      assertNoPayload(spans)
    } finally {
      releaseCheckpoint()
      await recording
      hasCheckpoint.mockRestore()
      acknowledge.mockRestore()
      await registry.dispose()
      await fixture.cleanup()
    }
  })

  it("preserves download retry counters and byte facts through the actual exporter projection", async () => {
    const { logger, spans } = offlineLogger()
    const api = fileApi()
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(
        new TypeError("private-response", {
          cause: Object.assign(new Error("private-response"), { code: "ECONNRESET" }),
        }),
      )
      .mockResolvedValueOnce(new Response("data"))
    await expect(
      downloadTelegramFile(
        api,
        "123456:private-token",
        { fileId: "private-file-id" },
        100,
        fetchImplementation,
        60_000,
        undefined,
        logger,
      ),
    ).resolves.toEqual(Buffer.from("data"))
    const span = spans.find(({ name }) => name === "telegram.download")
    expect(span?.attributes).toMatchObject({
      "download.max_bytes": 100,
      "download.attempts": 2,
      "download.bytes": 4,
      "download.phase": "stream",
      "download.outcome": "success",
    })
    expect(api.getFile).toHaveBeenCalledTimes(2)
    expect(fetchImplementation).toHaveBeenCalledTimes(2)
    assertNoPayload(spans)
  })

  it("does not turn a real helper's rejected input into an ERROR span", async () => {
    const { logger, spans } = offlineLogger()
    const api = fileApi()
    const fetchImplementation = vi.fn<typeof fetch>()
    await expect(
      downloadTelegramFile(
        api,
        "123456:private-token",
        { fileId: "private-file-id", fileSize: 101 },
        100,
        fetchImplementation,
        60_000,
        undefined,
        logger,
      ),
    ).rejects.toBeInstanceOf(TelegramDownloadTooLargeError)
    const span = spans.find(({ name }) => name === "telegram.download")
    expect(span?.attributes).toMatchObject({
      "download.outcome": "rejected",
      "operation.outcome": "rejected",
      "download.attempts": 0,
      "download.bytes": 0,
    })
    expect(span?.status.code).toBe(0)
    expect(span?.attributes["logfire.level_num"]).not.toBe(17)
    expect(api.getFile).not.toHaveBeenCalled()
    expect(fetchImplementation).not.toHaveBeenCalled()
    assertNoPayload(spans)
  })

  it("keeps a cancelled ambiguous media upload non-error without repeating it", async () => {
    const { logger, spans } = offlineLogger()
    let current = true
    const failure = Object.assign(new Error("private-response"), { code: "ECONNRESET" })
    const sendPhoto = vi.fn(async () => {
      current = false
      throw failure
    })
    const context = { chat: { id: 123 }, api: { sendPhoto } } as unknown as Context
    const sessions = {
      assertResponseMediaAccess: vi.fn(async () => {}),
      readResponseImage: vi.fn(async () => Buffer.from("fixture-image-bytes")),
      recordResponseComponent: vi.fn(async () => {}),
      recordDelivery: vi.fn(async () => {}),
    }
    const delivery = createTelegramDelivery({ isConfigured: false, publish: vi.fn() }, logger)
    const image: GeneratedMedia = {
      id: "host-image-receipt",
      extension: "png",
      mimeType: "image/png",
      width: 1,
      height: 1,
      byteLength: 19,
      sha256: "fixture",
      taskId: 1,
      callId: "fixture-call",
    }
    await expect(
      deliverGeneratedResponse(
        context,
        sessions,
        delivery,
        { text: "private-response", media: [image] },
        {
          sessionId: "session_id-fixture",
          requestId: "fixture-request",
          entryId: "1:1",
          generation: 0,
        },
        { sourceMessageId: 10, mode: "default" },
        () => current,
        logger,
      ),
    ).rejects.toBe(failure)
    const deliveries = spans.filter(({ name }) => name.startsWith("telegram.deliver"))
    expect(deliveries).toHaveLength(2)
    for (const span of deliveries) {
      expect(span.attributes).toMatchObject({
        "telegram.chat_id": 123,
        "telegram.message_id": 10,
        "pi.session_id": "session_id-fixture",
        "pi.request_id": "fixture-request",
        "delivery.outcome": "cancelled",
        "operation.outcome": "cancelled",
        "delivery.stage": "upload",
      })
      expect(span.status.code).toBe(0)
      expect(span.attributes["logfire.level_num"]).not.toBe(17)
    }
    expect(sendPhoto).toHaveBeenCalledOnce()
    expect(sessions.recordResponseComponent).not.toHaveBeenCalled()
    expect(sessions.recordDelivery).not.toHaveBeenCalled()
    assertNoPayload(spans)
  })
})
