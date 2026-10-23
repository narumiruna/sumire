import { spawn } from "node:child_process"
import { once } from "node:events"
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import { CompactionEntry, type ConversationId, type EntryId } from "@earendil-works/pi-durable"
import { IMAGE_ENDPOINT } from "@narumitw/sumire-imagegen"
import { Bot, Context } from "grammy"
import { afterEach, expect, it, vi } from "vitest"
import { PNG, WEBP } from "../../../packages/imagegen/tests/fixtures.js"
import { GeneratedMediaFiles } from "../src/agent/durable/media.js"
import { BotSessionDoc, OutboxDoc } from "../src/agent/durable/state.js"
import { hasCodexImageAuth } from "../src/agent/imagegen.js"
import { TelegramReplyIndex } from "../src/agent/reply-index.js"
import { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { createTelegramAgentBot } from "../src/telegram/bot.js"
import { createTelegramDelivery } from "../src/telegram/delivery.js"
import { deliverGeneratedResponse } from "../src/telegram/media-delivery.js"
import { recoverTelegramResponses } from "../src/telegram/recovery.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const clean of cleanups.splice(0).reverse()) {
    try {
      await clean()
    } catch (error) {
      errors.push(error)
    }
  }
  vi.restoreAllMocks()
  if (errors.length) throw new AggregateError(errors, "Image fixture cleanup failed")
})
const encode = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64url")
const token = `${encode({ alg: "RS256" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })}.${encode("synthetic")}`
async function setup() {
  const fixture = await createPiFixture()
  cleanups.push(fixture.cleanup)
  const runtime = fixture.modelRuntime
  let enabled = true
  const usingOAuth = runtime.isUsingOAuth.bind(runtime)
  const status = runtime.getProviderAuthStatus.bind(runtime)
  const check = runtime.checkAuth.bind(runtime)
  const auth = runtime.getAuth.bind(runtime)
  vi.spyOn(runtime, "isUsingOAuth").mockImplementation((id) =>
    id === "openai-codex" ? enabled : usingOAuth(id),
  )
  vi.spyOn(runtime, "getProviderAuthStatus").mockImplementation((id) =>
    id === "openai-codex" ? { configured: enabled, source: "stored" } : status(id),
  )
  vi.spyOn(runtime, "checkAuth").mockImplementation((id, options) =>
    id === "openai-codex"
      ? Promise.resolve(enabled ? { type: "oauth" as const } : undefined)
      : check(id, options),
  )
  vi.spyOn(runtime, "getAuth").mockImplementation(
    (model: string | Parameters<typeof runtime.getAuth>[0], options) => {
      if (model === "openai-codex") return Promise.resolve({ auth: { apiKey: token } })
      return typeof model === "string" ? auth(model, options) : auth(model, options)
    },
  )
  const originalFetch = globalThis.fetch
  const imageFetch = vi.fn(
    async (_input: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }), {
        headers: { "content-type": "application/json" },
      }),
  )
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    String(input) === IMAGE_ENDPOINT ? imageFetch(input, init) : originalFetch(input, init),
  )
  return {
    ...fixture,
    imageFetch,
    revoke() {
      enabled = false
    },
  }
}

it("gates availability on compatible Codex OAuth, not the text model provider", async () => {
  const fixture = await setup()
  expect(hasCodexImageAuth(fixture.modelRuntime)).toBe(true)
  const session = await fixture.createSession()
  expect(session.model.provider).toBe("openai")
  expect(
    session.registry
      .snapshot()
      .tools()
      .find(({ tool }) => tool.name === "generate_image")?.tool.replay,
  ).toBe("unsafe")
  expect(session.getActiveToolNames()).toContain("generate_image")
  fixture.revoke()
  const next = await fixture.createSession(456)
  expect(next.getActiveToolNames()).not.toContain("generate_image")
  expect(fixture.imageFetch).not.toHaveBeenCalled()
})
it("does not enable imagegen for the separate openai OAuth flow", async () => {
  const fixture = await setup()
  vi.spyOn(fixture.modelRuntime, "isUsingOAuth").mockImplementation((id) => id === "openai")
  expect(hasCodexImageAuth(fixture.modelRuntime)).toBe(false)
  const session = await fixture.createSession()
  expect(session.getActiveToolNames()).not.toContain("generate_image")
  expect(fixture.imageFetch).not.toHaveBeenCalled()
})
it("rejects credential replacement during auth resolution before HTTP", async () => {
  const fixture = await setup()
  const session = await fixture.createSession()
  vi.spyOn(fixture.modelRuntime, "getAuth").mockImplementation(async () => {
    fixture.revoke()
    return { auth: { apiKey: token } }
  })
  fixture.enqueue("generate_image", { prompt: "fox" })
  const answer = await session.prompt("Generate", {
    delivery: { sourceMessageId: 10, mode: "default" },
  })
  expect(answer.media).toBeUndefined()
  expect(fixture.imageFetch).not.toHaveBeenCalled()
})
it("does not record an artifact after a file publication failure or expose its raw error", async () => {
  const fixture = await setup()
  const session = await fixture.createSession()
  vi.spyOn(GeneratedMediaFiles.prototype, "save").mockRejectedValue(
    new Error("/private/secret-path"),
  )
  fixture.enqueue("generate_image", { prompt: "fox" })
  const answer = await session.prompt("Generate", {
    delivery: { sourceMessageId: 10, mode: "default" },
  })
  expect(answer.media).toBeUndefined()
  expect(JSON.stringify(session.messages)).not.toContain("/private/secret-path")
  expect(fixture.imageFetch).toHaveBeenCalledTimes(1)
  expect(await readdir(path.join(path.dirname(session.sessionFile), "images"))).toEqual([])
})
it("remembers imagegen without enabling it on upgrade and obeys explicit policy", async () => {
  const fixture = await setup()
  const store = fixture.factory.control
  const before = store.snapshot()
  before.policy.tools = before.policy.tools.filter((n) => n !== "generate_image")
  before.policy.defaults.tools = before.policy.tools
  const saved = store.save(before.policy, before.revision, "7")
  store.applied(saved.revision, true)
  store.db.prepare("DELETE FROM known_tools WHERE name='generate_image'").run()
  const factory = await fixture.createFactory()
  expect(factory.toolNames).toContain("generate_image")
  expect(store.snapshot().policy.tools).not.toContain("generate_image")
  const session = await factory.create(123)
  cleanups.push(() => session.dispose())
  expect(session.getActiveToolNames()).not.toContain("generate_image")
  expect(fixture.imageFetch).not.toHaveBeenCalled()
})
it.each([false, true])(
  "persists direct/nested media provenance even if codemode discards results (nested=%s)",
  async (nested) => {
    const fixture = await setup()
    const session = await fixture.createSession()
    fixture.enqueue(
      nested ? "codemode" : "generate_image",
      nested
        ? { code: 'await tools.generate_image({prompt:"fox"}); text("done");' }
        : { prompt: "fox" },
    )
    const answer = await session.prompt("Generate a fox", {
      delivery: { sourceMessageId: 10, mode: "default" },
    })
    expect(answer.media).toHaveLength(1)
    expect(fixture.imageFetch).toHaveBeenCalledTimes(1)
    const image = answer.media?.[0]
    expect(image?.callId.includes("/")).toBe(nested)
    const pending = (await session.harness.snapshot(OutboxDoc, context))?.pending
    expect(pending).toHaveLength(1)
    expect(pending?.[0]?.media).toEqual(answer.media)
    expect(
      await session.readResponseImage(answer.requestId as string, image?.id as string),
    ).toEqual(PNG)
    const file = path.join(path.dirname(session.sessionFile), "images", `${image?.id}.png`)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    await expect(session.acknowledge(answer.requestId as string)).rejects.toThrow("incomplete")
  },
)
it("keeps image-only output successful and separates concurrent chats and pending answers", async () => {
  const fixture = await setup()
  const first = await fixture.createSession(123)
  const other = await fixture.createSession(456)
  const generate = async (session: typeof first, id: number) => {
    fixture.enqueue("generate_image", { prompt: "fox" }, false)
    fixture.enqueueAnswer("")
    return session.prompt("Generate", { delivery: { sourceMessageId: id, mode: "default" } })
  }
  const a = await generate(first, 10)
  const b = await generate(first, 11)
  const c = await generate(other, 12)
  expect(a.text).toBe("")
  expect(b.media?.[0]?.id).not.toBe(a.media?.[0]?.id)
  expect(c.media?.[0]?.id).not.toBe(a.media?.[0]?.id)
  await expect(
    other.readResponseImage(a.requestId as string, a.media?.[0]?.id as string),
  ).rejects.toThrow()
  const recovered: unknown[] = []
  await first.recoverPending(async (answer) => {
    recovered.push(answer)
  })
  expect(recovered).toMatchObject([
    { requestId: a.requestId, media: a.media },
    { requestId: b.requestId, media: b.media },
  ])
  expect(fixture.imageFetch).toHaveBeenCalledTimes(3)
})
it("retains committed images when the final model request fails", async () => {
  const fixture = await setup()
  const session = await fixture.createSession()
  fixture.enqueue("generate_image", { prompt: "fox" }, false)
  fixture.enqueueFailure()
  const answer = await session.prompt("Generate", {
    delivery: { sourceMessageId: 10, mode: "default" },
  })
  expect(answer.media).toHaveLength(1)
  const requests = fixture.requests.length
  await session.recoverPending(async (recovered) => {
    expect(recovered.media).toEqual(answer.media)
  })
  expect(fixture.requests).toHaveLength(requests)
  expect(fixture.imageFetch).toHaveBeenCalledTimes(1)
})
it("recovers original bytes after storage reopen, without generation, and cleans acknowledged files", async () => {
  const fixture = await setup()
  const session = await fixture.createSession()
  fixture.enqueue("generate_image", { prompt: "fox" })
  const answer = await session.prompt("Generate", {
    delivery: { sourceMessageId: 10, mode: "default" },
  })
  await session.dispose()
  const reopened = await (await fixture.createFactory()).create(123)
  cleanups.push(() => reopened.dispose())
  const requests = fixture.requests.length
  await reopened.recoverPending(async (recovered) => {
    const image = recovered.media?.[0]
    expect(image).toBeDefined()
    expect(
      await reopened.readResponseImage(recovered.requestId as string, image?.id as string),
    ).toEqual(PNG)
    await reopened.recordResponseComponent(recovered.requestId as string, "text", 20)
    await reopened.recordResponseComponent(recovered.requestId as string, image?.id as string, 21)
    await reopened.acknowledge(recovered.requestId as string)
  })
  expect(fixture.requests).toHaveLength(requests)
  expect(fixture.imageFetch).toHaveBeenCalledTimes(1)
  expect(await readdir(path.join(path.dirname(session.sessionFile), "images"))).toEqual([])
  expect((await reopened.harness.snapshot(OutboxDoc, context))?.mediaReceipts).toMatchObject([
    { id: answer.media?.[0]?.id, messageId: 21 },
  ])
})
it("reopens legacy text-only outbox records without media fields or another model request", async () => {
  const fixture = await setup()
  const session = await fixture.createSession()
  fixture.enqueueAnswer("Legacy text answer.")
  const answer = await session.prompt("Text only", {
    delivery: { sourceMessageId: 10, mode: "default" },
  })
  await session.harness.commit(async (tx) => {
    const doc = await tx.doc(OutboxDoc)
    delete (doc as { mediaReceipts?: unknown }).mediaReceipts
  }, context)
  const pending = (await session.harness.snapshot(OutboxDoc, context))?.pending
  await session.dispose()
  const reopened = await (await fixture.createFactory()).create(123)
  cleanups.push(() => reopened.dispose())
  expect((await reopened.harness.snapshot(OutboxDoc, context))?.pending).toEqual(pending)
  const requests = fixture.requests.length
  await reopened.recoverPending(async (recovered) => {
    expect(recovered).toMatchObject({ text: "Legacy text answer.", requestId: answer.requestId })
    expect(recovered.media).toBeUndefined()
    await reopened.acknowledge(recovered.requestId as string)
  })
  expect(fixture.requests).toHaveLength(requests)
  expect(await reopened.hasPendingResponses()).toBe(false)
})
it("revocation blocks stale generation and media reads; cancellation removes pending files", async () => {
  const fixture = await setup()
  const session = await fixture.createSession()
  fixture.enqueue("generate_image", { prompt: "fox" })
  const answer = await session.prompt("Generate", {
    delivery: { sourceMessageId: 10, mode: "default" },
  })
  fixture.revoke()
  await expect(
    session.readResponseImage(answer.requestId as string, answer.media?.[0]?.id as string),
  ).rejects.toThrow()
  await session.abort()
  expect(await session.hasPendingResponses()).toBe(false)
  expect(await readdir(path.join(path.dirname(session.sessionFile), "images"))).toEqual([])
})
it("cancels a stalled image request and rejects late publication", async () => {
  const fixture = await setup()
  const session = await fixture.createSession()
  let started = () => {}
  const ready = new Promise<void>((r) => {
    started = r
  })
  fixture.imageFetch.mockImplementation(async (_input, init) => {
    started()
    return new Promise((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new Error("fixture cancellation")), {
        once: true,
      }),
    )
  })
  fixture.enqueue("generate_image", { prompt: "fox" }, false)
  const running = session.prompt("Generate", { delivery: { sourceMessageId: 10, mode: "default" } })
  await ready
  await session.abort()
  await running
  expect(await session.hasPendingResponses()).toBe(false)
  expect(await readdir(path.join(path.dirname(session.sessionFile), "images"))).toEqual([])
  expect(fixture.imageFetch).toHaveBeenCalledTimes(1)
})
it("rejects custom gateways and API-key auth without making an image request", async () => {
  const fixture = await setup()
  const provider = fixture.modelRuntime.getProvider("openai-codex")
  if (!provider) throw new Error("Missing fixture Codex provider")
  vi.spyOn(fixture.modelRuntime, "getProvider").mockReturnValue({
    ...provider,
    baseUrl: "https://example.com",
  })
  expect(hasCodexImageAuth(fixture.modelRuntime)).toBe(false)
  fixture.revoke()
  expect(hasCodexImageAuth(fixture.modelRuntime)).toBe(false)
  expect(fixture.imageFetch).not.toHaveBeenCalled()
})
it("preserves media delivery components across partial failure and startup recovery", async () => {
  const fixture = await setup()
  let owner: Awaited<ReturnType<typeof fixture.createSession>> | undefined
  const registry = new ChatSessionRegistry(
    async (chatId) => {
      owner = await fixture.createSession(chatId)
      return owner
    },
    fixture.settings.botSessionLogDir,
    fixture.logger,
    { control: fixture.factory.control, replyTreeEnabled: true },
  )
  cleanups.push(() => registry.dispose())
  fixture.enqueue("generate_image", { prompt: "fox" })
  const answer = await registry.submit(123, "Generate", {
    delivery: { sourceMessageId: 10, mode: "default" },
  })
  if (answer.kind !== "completed" || !answer.checkpoint) throw new Error("Missing fixture image")
  const bot = new Bot("123:synthetic")
  bot.botInfo = {
    id: 123,
    is_bot: true,
    first_name: "Fixture",
    username: "fixture_bot",
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
  const sent: Array<{ method: string; data: unknown }> = []
  let failing = true
  bot.api.config.use(async (_previous, method, payload) => {
    sent.push({ method, data: payload })
    if (method === "sendPhoto" && failing) throw new Error("offline upload failure")
    return {
      ok: true,
      result: {
        message_id: 20 + sent.length,
        chat: { id: 123, type: "private" },
        date: 0,
        text: "delivered",
      },
    } as never
  })
  const ctx = new Context(
    {
      update_id: 1,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: 123, type: "private", first_name: "Fixture" },
        text: "Generate",
        from: { id: 7, is_bot: false, first_name: "Fixture" },
      },
    },
    bot.api,
    bot.botInfo,
  )
  const delivery = createTelegramDelivery(
    {
      isConfigured: false,
      publish: async () => {
        throw new Error("not used")
      },
    },
    fixture.logger,
  )
  await expect(
    deliverGeneratedResponse(
      ctx,
      registry,
      delivery,
      answer,
      answer.checkpoint,
      { sourceMessageId: 10, mode: "default" },
      () => true,
    ),
  ).rejects.toThrow("offline upload failure")
  expect(sent.map((x) => x.method)).toEqual(["sendMessage", "sendPhoto"])
  failing = false
  await recoverTelegramResponses(bot, registry, delivery, [123])
  // recover() starts delivery in the background. Wait on its observable acknowledgement, not a sleep.
  await vi.waitFor(async () => {
    expect(await owner?.hasPendingResponses()).toBe(false)
  })
  expect(sent.filter((x) => x.method === "sendPhoto")).toHaveLength(2)
  expect(sent.filter((x) => x.method === "sendMessage")).toHaveLength(1)
  expect(fixture.imageFetch).toHaveBeenCalledTimes(1)
})
it("keeps pending media through compaction and does not copy it to a sibling reply", async () => {
  const fixture = await setup()
  const session = await fixture.createSession()
  fixture.enqueue("generate_image", { prompt: "fox" })
  const answer = await session.prompt("Generate", {
    delivery: { sourceMessageId: 10, mode: "default" },
  })
  const leaf = answer.entryId
  if (!leaf) throw new Error("Missing image checkpoint")
  const state = await session.harness.snapshot(BotSessionDoc, context)
  const conversation = await session.harness.conversation(
    state?.activeConversation as ConversationId,
    context,
  )
  if (!conversation) throw new Error("Missing conversation")
  await conversation.commit(
    (tx) =>
      tx.appendEntry(CompactionEntry, conversation.id, {
        head: Number(leaf.split(":")[1]) as EntryId,
        data: { reason: "manual" },
        model: [
          { role: "user", content: "Earlier image generation summarized.", timestamp: Date.now() },
        ],
      }),
    context,
  )
  await session.restoreBranch(leaf)
  fixture.enqueueAnswer("Sibling reply without new generation.")
  const sibling = await session.prompt("Explain", {
    delivery: { sourceMessageId: 11, mode: "default" },
  })
  expect(sibling.media).toBeUndefined()
  const recovered: Array<{ requestId?: string; media?: unknown }> = []
  await session.recoverPending(async (value) => {
    recovered.push(value)
  })
  expect(recovered.find((item) => item.requestId === answer.requestId)?.media).toEqual(answer.media)
  expect(recovered.find((item) => item.requestId === sibling.requestId)?.media).toBeUndefined()
  expect(fixture.imageFetch).toHaveBeenCalledTimes(1)
})
it("does not replay an unsafe image request after interrupted Harness shutdown", async () => {
  const fixture = await setup()
  const session = await fixture.createSession()
  let started = () => {}
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  fixture.imageFetch.mockImplementation(async (_input, init) => {
    started()
    return new Promise((_resolve, reject) =>
      init?.signal?.addEventListener("abort", () => reject(new Error("interrupted fixture")), {
        once: true,
      }),
    )
  })
  fixture.enqueue("generate_image", { prompt: "fox" }, false)
  const running = session.prompt("Generate", { delivery: { sourceMessageId: 10, mode: "default" } })
  await ready
  const stopped = expect(running).rejects.toThrow("Harness is closed")
  await session.dispose()
  await stopped
  const reopened = await (await fixture.createFactory()).create(123)
  cleanups.push(() => reopened.dispose())
  fixture.enqueueAnswer("Image request was interrupted; not retried.")
  await reopened.recoverPending(async (recovered) => {
    expect(recovered.media).toBeUndefined()
  })
  expect(fixture.imageFetch).toHaveBeenCalledTimes(1)
})
it("recovers committed original image bytes after SIGKILL without another model or image request", async () => {
  const fixture = await setup()
  fixture.enqueue("generate_image", { prompt: "fox" })
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      new URL("./fixtures/imagegen-crash.mjs", import.meta.url).pathname,
      fixture.root,
      fixture.endpoint,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  )
  let stderr = ""
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-4000)
  })
  const exited = once(child, "exit")
  try {
    const [message] = await Promise.race([
      once(child, "message"),
      exited.then(() => {
        throw new Error(`Image crash fixture exited: ${stderr}`)
      }),
    ])
    expect(message).toEqual({ type: "image-committed" })
    child.kill("SIGKILL")
    await exited
    const requests = fixture.requests.length
    const reopened = await fixture.createSession()
    await reopened.recoverPending(async (answer) => {
      const image = answer.media?.[0]
      if (!image || !answer.requestId) throw new Error("Missing committed image receipt")
      expect(await reopened.readResponseImage(answer.requestId, image.id)).toEqual(PNG)
      await reopened.recordResponseComponent(answer.requestId, "text", 90)
      await reopened.recordResponseComponent(answer.requestId, image.id, 91)
      await reopened.acknowledge(answer.requestId)
    })
    expect(fixture.requests).toHaveLength(requests)
    expect(fixture.imageFetch).not.toHaveBeenCalled()
    expect(await readFile(path.join(fixture.root, "imagegen-crash-requests.txt"), "utf8")).toBe(
      "1\n",
    )
    expect(await reopened.hasPendingResponses()).toBe(false)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await exited
  }
}, 15000)
it("does not attach a queued follow-up image to an unrelated completed answer", async () => {
  const fixture = await setup()
  const session = await fixture.createSession()
  fixture.enqueueAnswer("Earlier completed reply.")
  const earlier = await session.prompt("Earlier", {
    delivery: { sourceMessageId: 9, mode: "default" },
  })
  const release = fixture.pauseNextRequest()
  fixture.enqueueAnswer("Intermediate reply.")
  fixture.enqueue("generate_image", { prompt: "fox" })
  const current = session.prompt("Start", { delivery: { sourceMessageId: 10, mode: "default" } })
  await vi.waitFor(() => expect(fixture.requests).toHaveLength(2))
  await session.followUp("Generate a fox")
  release()
  const answer = await current
  expect(answer.media).toHaveLength(1)
  const recovered: Array<{ requestId?: string; media?: unknown }> = []
  await session.recoverPending(async (value) => {
    recovered.push(value)
  })
  expect(recovered.find((item) => item.requestId === earlier.requestId)?.media).toBeUndefined()
  expect(recovered.find((item) => item.requestId === answer.requestId)?.media).toEqual(answer.media)
  expect(fixture.imageFetch).toHaveBeenCalledTimes(1)
})
it("reset removes generated files and cannot publish an old response", async () => {
  const fixture = await setup()
  const registry = new ChatSessionRegistry(
    fixture.createSession,
    fixture.settings.botSessionLogDir,
    fixture.logger,
    { control: fixture.factory.control },
  )
  cleanups.push(() => registry.dispose())
  fixture.enqueue("generate_image", { prompt: "fox" })
  const result = await registry.submit(123, "Generate", {
    delivery: { sourceMessageId: 10, mode: "default" },
  })
  if (result.kind !== "completed" || !result.checkpoint || !result.media?.[0])
    throw new Error("Missing image")
  await registry.reset(123)
  await expect(
    registry.readResponseImage(123, result.checkpoint, result.media[0].id),
  ).rejects.toThrow()
  await expect(
    stat(path.join(fixture.settings.botSessionLogDir, "123", "durable")),
  ).rejects.toThrow()
})
it.each([
  [PNG, "sendPhoto"],
  [WEBP, "sendDocument"],
] as const)(
  "delivers a normal natural-language bot request through the full transport (%s)",
  async (bytes, method) => {
    const fixture = await setup()
    fixture.imageFetch.mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: [{ b64_json: bytes.toString("base64") }] }), {
          headers: { "content-type": "application/json" },
        }),
    )
    let owner: Awaited<ReturnType<typeof fixture.createSession>> | undefined
    const registry = new ChatSessionRegistry(
      async (chatId) => {
        owner = await fixture.createSession(chatId)
        return owner
      },
      fixture.settings.botSessionLogDir,
      fixture.logger,
      { control: fixture.factory.control, replyTreeEnabled: true },
    )
    cleanups.push(() => registry.dispose())
    const telegram = createTelegramAgentBot(
      { ...fixture.settings, botToken: "123:synthetic" },
      registry,
      fixture.logger,
      {
        control: fixture.factory.control,
        botInfo: {
          id: 123,
          is_bot: true,
          first_name: "Fixture",
          username: "fixture_bot",
          can_join_groups: true,
          can_read_all_group_messages: true,
          supports_inline_queries: false,
          can_connect_to_business: false,
          has_main_web_app: false,
          has_topics_enabled: false,
          allows_users_to_create_topics: false,
          can_manage_bots: false,
          supports_join_request_queries: false,
        },
      },
    )
    const sent: Array<{ method: string; payload: Record<string, unknown> }> = []
    telegram.bot.api.config.use(async (_previous, name, payload) => {
      sent.push({ method: name, payload })
      return {
        ok: true,
        result:
          name === "sendChatAction"
            ? true
            : {
                message_id: 20 + sent.length,
                date: 0,
                chat: { id: 7, type: "private" },
                text: "text" in payload ? payload.text : undefined,
              },
      } as never
    })
    fixture.enqueue("generate_image", { prompt: "a fox" })
    await telegram.bot.handleUpdate({
      update_id: 10,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: 7, type: "private", first_name: "Fixture" },
        from: { id: 7, is_bot: false, first_name: "Fixture" },
        text: "請生成一張狐狸的圖片",
      },
    })
    expect(sent.filter((item) => item.method === method)).toHaveLength(1)
    expect(sent.find((item) => item.method === method)?.payload).toMatchObject({
      chat_id: 7,
      reply_parameters: { message_id: 10 },
    })
    expect(await owner?.hasPendingResponses()).toBe(false)
    const index = new TelegramReplyIndex(
      fixture.settings.botSessionLogDir,
      1000,
      1_000_000,
      fixture.logger,
    )
    for (const name of [method, "sendMessage"]) {
      const position = sent.findIndex((item) => item.method === name)
      expect(await index.resolve(7, 21 + position)).toEqual({
        sessionId: owner?.sessionId,
        entryId: owner?.getCheckpoint(),
      })
    }
    expect(fixture.imageFetch).toHaveBeenCalledTimes(1)
  },
)
it("packages the image client in every Docker stage and CI path filter", async () => {
  const docker = await readFile(new URL("../../../Dockerfile", import.meta.url), "utf8")
  expect(docker).toContain("COPY packages/imagegen/package.json packages/imagegen/package.json")
  expect(docker).toContain("FROM dependencies AS imagegen-build")
  expect(docker).toContain(
    "COPY --from=imagegen-build /build/packages/imagegen/dist /build/packages/imagegen/dist",
  )
  expect(docker).toContain(
    "/build/packages/imagegen/package.json /app/packages/imagegen/package.json",
  )
  expect(docker).toContain("/build/packages/imagegen/dist /app/packages/imagegen/dist")
  expect(docker).toContain("import('/app/packages/imagegen/dist/index.js')")
  const ci = await readFile(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8")
  expect(ci.match(/packages\/imagegen\/\*\*/g)).toHaveLength(2)
})
