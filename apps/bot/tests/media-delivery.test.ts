import { randomUUID } from "node:crypto"
import { mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { decodeImage } from "@narumitw/sumire-imagegen"
import { Bot, Context, InputFile } from "grammy"
import { afterEach, expect, it, vi } from "vitest"
import { PNG } from "../../../packages/imagegen/tests/fixtures.js"
import { type GeneratedMedia, GeneratedMediaFiles } from "../src/agent/durable/media.js"
import { createTelegramDelivery } from "../src/telegram/delivery.js"
import { deliverGeneratedResponse, telegramImageMethod } from "../src/telegram/media-delivery.js"

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>()
  return { ...fs, rename: vi.fn(fs.rename) }
})

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
const image: GeneratedMedia = {
  id: randomUUID(),
  extension: "png",
  mimeType: "image/png",
  width: 2,
  height: 1,
  byteLength: PNG.length,
  sha256: "fixture",
  taskId: 1,
  callId: "fixture-call",
}
const checkpoint = {
  requestId: "fixture-request",
  sessionId: "session",
  entryId: "1:1",
  generation: 0,
}
const logger = { debug() {}, info() {}, warn() {}, error() {} }
const delivery = createTelegramDelivery(
  {
    isConfigured: false,
    publish: async () => {
      throw new Error("not used")
    },
  },
  logger,
)
function setup() {
  const bot = new Bot("123:synthetic")
  const methods: Array<{ method: string; payload: Record<string, unknown> }> = []
  bot.api.config.use(async (_previous, method, payload) => {
    methods.push({ method, payload })
    return {
      ok: true,
      result: { message_id: 20 + methods.length, chat: { id: 123, type: "private" }, date: 0 },
    } as never
  })
  const ctx = new Context(
    {
      update_id: 1,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: 123, type: "private", first_name: "Fixture" },
        from: { id: 7, is_bot: false, first_name: "Fixture" },
      },
    },
    bot.api,
    {} as never,
  )
  const sessions = {
    assertResponseMediaAccess: vi.fn(() => {}),
    readResponseImage: vi.fn(async () => PNG),
    recordResponseComponent: vi.fn(
      async (
        _chatId: number,
        _checkpoint: typeof checkpoint,
        _component: string,
        _messageId: number,
      ) => {},
    ),
    recordDelivery: vi.fn(async () => {}),
  }
  return { bot, ctx, methods, sessions }
}
it.each([
  [{ ...image, byteLength: 10_000_000 }, "sendPhoto"],
  [{ ...image, byteLength: 10_000_001 }, "sendDocument"],
  [{ ...image, width: 5000, height: 5000 }, "sendPhoto"],
  [{ ...image, width: 5001, height: 5000 }, "sendDocument"],
  [{ ...image, width: 2000, height: 100 }, "sendPhoto"],
  [{ ...image, width: 2001, height: 100 }, "sendDocument"],
  [{ ...image, mimeType: "image/webp" }, "sendDocument"],
] as const)("selects transport by fixed photo constraints", (media, method) => {
  expect(telegramImageMethod(media)).toBe(method)
})
it.each(["image/png", "image/webp"])(
  "uploads original bytes as local InputFile (%s)",
  async (mimeType) => {
    const f = setup()
    await deliverGeneratedResponse(
      f.ctx,
      f.sessions,
      delivery,
      { text: "", media: [{ ...image, mimeType }] },
      checkpoint,
      { sourceMessageId: 10, mode: "default" },
      () => true,
    )
    expect(f.methods.map((x) => x.method)).toEqual([
      mimeType === "image/png" ? "sendPhoto" : "sendDocument",
      "sendMessage",
    ])
    const payload = f.methods[0]?.payload
    const file = (payload?.photo ?? payload?.document) as InputFile
    expect(file).toBeInstanceOf(InputFile)
    expect(file.filename).toBe(`${image.id}.png`)
    const bytes = await file.toRaw()
    expect(bytes).toEqual(PNG)
    expect(payload?.chat_id).toBe(123)
    expect(payload?.reply_parameters).toEqual({ message_id: 10, allow_sending_without_reply: true })
    expect(f.sessions.recordDelivery).toHaveBeenCalledWith(123, checkpoint, [21, 22])
    expect(f.sessions.recordResponseComponent.mock.calls.map((call) => call[2])).toEqual([
      image.id,
      "text",
    ])
  },
)
it("skips confirmed components, including all components after send-before-ack interruption", async () => {
  const f = setup()
  await deliverGeneratedResponse(
    f.ctx,
    f.sessions,
    delivery,
    { text: "done", textMessageIds: [50], media: [{ ...image, messageId: 51 }] },
    checkpoint,
    { sourceMessageId: 10, mode: "default" },
    () => true,
  )
  expect(f.methods).toEqual([])
  expect(f.sessions.readResponseImage).not.toHaveBeenCalled()
  expect(f.sessions.recordDelivery).toHaveBeenCalledWith(123, checkpoint, [50, 51])
})
it("skips a confirmed image and uploads only the remaining component", async () => {
  const f = setup()
  const second = { ...image, id: randomUUID() }
  await deliverGeneratedResponse(
    f.ctx,
    f.sessions,
    delivery,
    { text: "done", textMessageIds: [49], media: [{ ...image, messageId: 50 }, second] },
    checkpoint,
    { sourceMessageId: 10, mode: "default" },
    () => true,
  )
  expect(f.methods.map((item) => item.method)).toEqual(["sendPhoto"])
  expect(f.sessions.readResponseImage).toHaveBeenCalledTimes(1)
  expect(f.sessions.recordResponseComponent).toHaveBeenCalledWith(123, checkpoint, second.id, 21)
  expect(f.sessions.recordDelivery).toHaveBeenCalledWith(123, checkpoint, [49, 50, 21])
})
it("does not send stale work or acknowledge after invalidation during file reads", async () => {
  const f = setup()
  let current = false
  await deliverGeneratedResponse(
    f.ctx,
    f.sessions,
    delivery,
    { text: "done", media: [image] },
    checkpoint,
    { sourceMessageId: 10, mode: "default" },
    () => current,
  )
  expect(f.methods).toEqual([])
  current = true
  f.sessions.readResponseImage.mockImplementation(async () => {
    current = false
    return PNG
  })
  expect(
    await deliverGeneratedResponse(
      f.ctx,
      f.sessions,
      delivery,
      { text: "done", textMessageIds: [20], media: [image] },
      checkpoint,
      { sourceMessageId: 10, mode: "default" },
      () => current,
    ),
  ).toBe("stale")
  expect(f.methods).toEqual([])
  expect(f.sessions.recordDelivery).not.toHaveBeenCalled()
})
it("checks auth again before text publication and after asynchronous reads", async () => {
  const f = setup()
  f.sessions.assertResponseMediaAccess.mockImplementation(() => {
    throw new Error("auth revoked")
  })
  expect(
    await deliverGeneratedResponse(
      f.ctx,
      f.sessions,
      delivery,
      { text: "done", media: [image] },
      checkpoint,
      { sourceMessageId: 10, mode: "default" },
      () => true,
    ),
  ).toBe("stale")
  expect(f.methods).toEqual([])
  f.sessions.assertResponseMediaAccess.mockImplementation(() => {})
  f.sessions.readResponseImage.mockImplementation(async () => {
    f.sessions.assertResponseMediaAccess.mockImplementation(() => {
      throw new Error("auth revoked")
    })
    return PNG
  })
  expect(
    await deliverGeneratedResponse(
      f.ctx,
      f.sessions,
      delivery,
      { text: "done", textMessageIds: [20], media: [image] },
      checkpoint,
      { sourceMessageId: 10, mode: "default" },
      () => true,
    ),
  ).toBe("stale")
  expect(f.methods).toEqual([])
  expect(f.sessions.recordDelivery).not.toHaveBeenCalled()
})
it("never falls back after ambiguous upload failure and leaves the response pending", async () => {
  const f = setup()
  f.bot.api.config.use(async (_previous, method) => {
    f.methods.push({ method, payload: {} })
    throw new Error("ambiguous network failure")
  })
  await expect(
    deliverGeneratedResponse(
      f.ctx,
      f.sessions,
      delivery,
      { text: "done", textMessageIds: [20], media: [image] },
      checkpoint,
      { sourceMessageId: 10, mode: "default" },
      () => true,
    ),
  ).rejects.toThrow("ambiguous")
  expect(f.methods.map((x) => x.method)).toEqual(["sendPhoto"])
  expect(f.sessions.recordDelivery).not.toHaveBeenCalled()
})
it("uploads images directly even when required long-text publication is unavailable", async () => {
  const f = setup()
  const result = await deliverGeneratedResponse(
    f.ctx,
    f.sessions,
    delivery,
    { text: "long text ".repeat(200), media: [image] },
    checkpoint,
    { sourceMessageId: 10, mode: "default" },
    () => true,
  )
  expect(result).toBe("unavailable")
  expect(f.methods.map((item) => item.method)).toEqual(["sendPhoto", "sendMessage"])
  expect(f.sessions.recordResponseComponent).toHaveBeenCalledWith(123, checkpoint, image.id, 21)
  expect(f.sessions.recordDelivery).not.toHaveBeenCalled()
})
it.each([false, true])(
  "uploads images before waiting for text publication (cancelled=%s)",
  async (cancelled) => {
    const f = setup()
    let current = true
    let release = () => {}
    let started = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const publishing = new Promise<void>((resolve) => {
      started = resolve
    })
    const slowDelivery = createTelegramDelivery(
      {
        isConfigured: true,
        publish: async () => {
          started()
          await gate
          return "https://morsel.example/share/fixture"
        },
      },
      logger,
    )
    const pending = deliverGeneratedResponse(
      f.ctx,
      f.sessions,
      slowDelivery,
      { text: "long text ".repeat(200), media: [image] },
      checkpoint,
      { sourceMessageId: 10, mode: "default" },
      () => current,
    )
    let result: Awaited<typeof pending> | undefined
    try {
      await publishing
      expect(f.methods.map((item) => item.method)).toEqual(["sendPhoto"])
      expect(f.sessions.recordResponseComponent).toHaveBeenCalledWith(123, checkpoint, image.id, 21)
      expect(f.sessions.recordDelivery).not.toHaveBeenCalled()
      if (cancelled) current = false
    } finally {
      release()
      result = await pending
    }
    expect(result).toBe(cancelled ? "stale" : "delivered")
    expect(f.methods.map((item) => item.method)).toEqual(
      cancelled ? ["sendPhoto"] : ["sendPhoto", "sendMessage"],
    )
    if (cancelled) expect(f.sessions.recordDelivery).not.toHaveBeenCalled()
    else expect(f.sessions.recordDelivery).toHaveBeenCalledWith(123, checkpoint, [21, 22])
  },
)
async function files() {
  const root = await mkdtemp(path.join(tmpdir(), "sumire-media-files-"))
  roots.push(root)
  return new GeneratedMediaFiles(root)
}
it("publishes originals atomically, detects changes, and prunes only unreferenced artifacts", async () => {
  const f = await files()
  const receipt = {
    ...(await f.save(decodeImage(PNG.toString("base64")))),
    taskId: 1,
    callId: "fixture",
  }
  const file = path.join(f.directory, `${receipt.id}.png`)
  expect(await readFile(file)).toEqual(PNG)
  expect(await f.read(receipt)).toEqual(PNG)
  const orphan = path.join(f.directory, `${randomUUID()}.png.tmp`)
  await writeFile(orphan, "partial")
  await f.prune([receipt])
  expect(await readdir(f.directory)).toEqual([`${receipt.id}.png`])
  await writeFile(file, Buffer.concat([PNG, Buffer.from([0])]))
  await expect(f.read(receipt)).rejects.toThrow("changed")
  await f.remove(receipt)
  expect(await readdir(f.directory)).toEqual([])
})
it("rejects traversal, symlink files, and symlink storage directories", async () => {
  const f = await files()
  const receipt = {
    ...(await f.save(decodeImage(PNG.toString("base64")))),
    taskId: 1,
    callId: "fixture",
  }
  await expect(f.read({ ...receipt, id: "../outside" })).rejects.toThrow("receipt")
  const file = path.join(f.directory, `${receipt.id}.png`)
  await rm(file)
  await symlink("/etc/hosts", file)
  await expect(f.read(receipt)).rejects.toThrow()
  await rm(f.directory, { recursive: true })
  await symlink(tmpdir(), f.directory)
  await expect(f.prepare()).rejects.toThrow()
})
it("removes the temporary file when atomic publication fails", async () => {
  const f = await files()
  vi.mocked(rename).mockRejectedValueOnce(new Error("fixture rename failure"))
  await expect(f.save(decodeImage(PNG.toString("base64")))).rejects.toThrow(
    "fixture rename failure",
  )
  expect(await readdir(f.directory)).toEqual([])
})
it("does not publish cancelled writes", async () => {
  const f = await files()
  await f.prepare()
  const controller = new AbortController()
  controller.abort()
  await expect(f.save(decodeImage(PNG.toString("base64")), controller.signal)).rejects.toThrow()
  expect(await readdir(f.directory)).toEqual([])
})
