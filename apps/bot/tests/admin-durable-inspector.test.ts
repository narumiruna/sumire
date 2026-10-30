import { request as httpRequest } from "node:http"
import type { AddressInfo } from "node:net"
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import { defineDoc } from "@earendil-works/pi-durable"
import type { DurableInspectionResponse } from "@narumitw/sumire-contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import { McpAdmin } from "../src/admin/mcp.js"
import { ProviderAdmin } from "../src/admin/providers.js"
import { createAdminServer } from "../src/admin/server.js"
import { sessionMaxAgeMs } from "../src/admin/store.js"
import type { DurableSession } from "../src/agent/durable/session.js"
import { BotSessionDoc, OutboxDoc } from "../src/agent/durable/state.js"
import { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { currentConversation } from "./helpers/durable-session.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

const cleanups: Array<() => Promise<void>> = []
function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup() {
  const fixture = await createPiFixture()
  cleanups.push(() => fixture.cleanup())
  const store = fixture.factory.control
  const owners = new Map<number, DurableSession>()
  const create = vi.fn(async (chatId: number) => {
    const session = await fixture.createSession(chatId)
    owners.set(chatId, session)
    return session
  })
  const registry = new ChatSessionRegistry(
    create,
    fixture.settings.botSessionLogDir,
    fixture.logger,
    { control: store },
  )
  cleanups.push(() => registry.dispose())
  const inspect = vi.fn((chatId, query, signal) => registry.inspectDurable(chatId, query, signal))
  const server = createAdminServer(
    { origin: "https://admin.example.test", host: "127.0.0.1", port: 0, assets: fixture.root },
    {
      store,
      mcp: new McpAdmin(store, fixture.root),
      providers: new ProviderAdmin(fixture.modelRuntime, store),
      tools: () => [],
      apply: async () => {},
      inspectDurable: inspect,
    },
  )
  await server.start()
  cleanups.push(() => server.stop())
  let login = store.createSession("7")
  const call = (url: string, method = "GET", authorized = true) => {
    let req: ReturnType<typeof httpRequest>
    const promise = new Promise<{ status: number; text: string; data: DurableInspectionResponse }>(
      (resolve, reject) => {
        req = httpRequest(
          {
            hostname: "127.0.0.1",
            port: (server.server.address() as AddressInfo).port,
            path: url,
            method,
            headers: {
              host: "admin.example.test",
              ...(authorized
                ? {
                    cookie: `__Host-sumire-session=${login.value}`,
                    origin: "https://admin.example.test",
                    "x-csrf-token": login.csrf,
                  }
                : {}),
            },
          },
          (response) => {
            let text = ""
            response.setEncoding("utf8")
            response.on("data", (chunk) => {
              text += chunk
            })
            response.on("end", () =>
              resolve({ status: response.statusCode ?? 0, text, data: JSON.parse(text) }),
            )
          },
        )
        req.on("error", reject)
        req.end()
      },
    )
    return { promise, destroy: () => req.destroy() }
  }
  const get = (url: string, method = "GET", authorized = true) =>
    call(url, method, authorized).promise
  const loaded = async (chatId = 123) => {
    await registry.appendPassiveContext(chatId, "Private fixture message must stay hidden")
    const session = owners.get(chatId)
    if (!session) throw new Error("Missing loaded owner")
    return session
  }
  return {
    fixture,
    store,
    owners,
    create,
    registry,
    inspect,
    server,
    call,
    get,
    loaded,
    revoke: () => store.revoke(login.value),
    expireSoon: () =>
      store.db
        .prepare("UPDATE sessions SET created=? WHERE hash=?")
        .run(
          Date.now() - sessionMaxAgeMs + 250,
          store.db.prepare("SELECT hash FROM sessions WHERE actor='7'").get()?.hash as string,
        ),
    relogin: () => {
      login = store.createSession("7")
    },
  }
}
const route = "/api/chats/123/durable"

describe("authenticated durable inspection HTTP", () => {
  it("does not load a chat and rejects unauthorized, mutating or malformed requests", async () => {
    const f = await setup()
    expect((await f.get(route, "GET", false)).status).toBe(401)
    expect(f.inspect).not.toHaveBeenCalled()
    const unloaded = await f.get(route)
    expect(unloaded.status).toBe(200)
    expect(unloaded.data).toMatchObject({ version: 1, state: "not-loaded", items: [] })
    expect(unloaded.data).not.toHaveProperty("selectedConversation")
    expect(f.create).not.toHaveBeenCalled()
    for (const method of ["POST", "PUT", "DELETE"])
      expect((await f.get(route, method)).status).toBe(405)
    for (const query of [
      "view=other",
      "view=tasks",
      "view=history",
      "view=history&conversationId=1&scope=session",
      "view=history&conversationId=1&taskId=2",
      "view=history&conversationId=1&objectId=2&cursor=x",
      "limit=101",
      "limit=0",
      "limit=1&limit=2",
      "conversationId=1",
      "view=documents&scope=task&conversationId=1",
      "unexpected=x",
      `cursor=${"x".repeat(4097)}`,
    ])
      expect((await f.get(`${route}?${query}`)).status, query).toBe(400)
    expect((await f.get("/api/chats/9007199254740992/durable")).status).toBe(400)
    expect((await f.get("/api/chats/0/durable")).status).toBe(404)
    expect(f.create).not.toHaveBeenCalled()
    expect(f.fixture.requests).toHaveLength(0)
  })

  it("returns bounded metadata and approved JSON without commits, recovery or payload exposure", async () => {
    const f = await setup()
    const session = await f.loaded()
    const conversation = await currentConversation(session)
    const secret = "INSPECTOR_PRIVATE_SENTINEL"
    const unknown = defineDoc({
      checkpointWhen: () => false,
      kind: "fixture.private",
      version: 1,
      scope: "session",
      initial: () => ({ secret }),
    })
    await session.harness.commit(async (tx) => {
      await tx.doc(unknown)
      ;(await tx.doc(OutboxDoc)).pending.push({
        requestId: "hidden",
        conversationId: conversation.id,
        content: secret,
        delivery: { sourceMessageId: 71, mode: "default" },
      })
    }, context)
    const sessionState = await session.harness.snapshot(BotSessionDoc, context)
    const before = await session.harness.inspect(context)
    const commits = vi.fn()
    const stop = session.harness.subscribeCommits(commits)
    try {
      for (const query of [
        "",
        `?view=tasks&conversationId=${conversation.id}`,
        `?view=entries&conversationId=${conversation.id}`,
        "?view=documents&scope=session",
        `?view=documents&conversationId=${conversation.id}`,
      ]) {
        const result = await f.get(`${route}${query}`)
        expect(result.status).toBe(200)
        expect(result.data.state).toBe("loaded")
        expect(result.text).not.toContain(secret)
        expect(result.text).not.toContain("Private fixture message")
        expect(result.text).not.toContain(sessionState?.trustKey)
        expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(256 * 1024)
      }
      const documents = (await f.get(`${route}?view=documents&scope=session`)).data.items
      const state = documents.find(
        (item) => item.type === "document" && item.kind === "sumire.session",
      )
      if (!state) throw new Error("Missing session document")
      const projected = await f.get(`${route}?view=documents&scope=session&objectId=${state.id}`)
      expect(projected.status).toBe(200)
      expect(projected.data.items[0]).toMatchObject({
        valueState: "available",
        value: { kind: "sumire.session", activeConversation: conversation.id },
      })
      expect(projected.text).not.toContain("trustKey")
      expect(projected.text).not.toContain("sessionId")
      const privateDoc = documents.find(
        (item) => item.type === "document" && item.kind === "fixture.private",
      )
      expect(privateDoc).toMatchObject({ valueState: "withheld" })
      expect(
        (await f.get(`${route}?view=documents&scope=session&objectId=${privateDoc?.id}`)).status,
      ).toBe(404)
      expect(
        (
          await f.get(
            `${route}?view=documents&conversationId=${conversation.id}&objectId=${state.id}`,
          )
        ).status,
      ).toBe(404)
      expect(await session.harness.inspect(context)).toEqual(before)
      expect(commits).not.toHaveBeenCalled()
      expect(f.fixture.requests).toHaveLength(0)
      expect((await session.harness.snapshot(OutboxDoc, context))?.pending).toHaveLength(1)
    } finally {
      stop()
    }
  })

  it("returns saved history only for authenticated loaded owners without loading or mutating a chat", async () => {
    const f = await setup()
    const request = `${route}?view=history&conversationId=1`
    expect((await f.get(request, "GET", false)).status).toBe(401)
    expect(f.inspect).not.toHaveBeenCalled()
    const unloaded = await f.get(request)
    expect(unloaded.status).toBe(200)
    expect(unloaded.data).toMatchObject({
      version: 1,
      state: "not-loaded",
      view: "history",
      items: [],
      truncated: false,
    })
    expect(f.create).not.toHaveBeenCalled()
    const session = await f.loaded()
    const conversation = await currentConversation(session)
    const entry = await session.harness.commit(
      (tx) =>
        tx.appendEntry(conversation.id, {
          kind: "pi.user",
          data: { credential: "PRIVATE_HISTORY_DATA" },
          model: [{ role: "user", content: "Saved addressed input", timestamp: 1 }],
        }),
      context,
    )
    const before = await session.harness.inspect(context)
    const commits = vi.fn()
    const unsubscribe = session.harness.subscribeCommits(commits)
    try {
      const history = await f.get(`${route}?view=history&conversationId=${conversation.id}&limit=1`)
      expect(history.status).toBe(200)
      expect(history.data).toMatchObject({
        state: "loaded",
        view: "history",
        truncated: false,
        items: [
          {
            id: entry.id,
            kind: "pi.user",
            content: {
              messages: [
                { role: "user", content: [{ type: "text", text: "Saved addressed input" }] },
              ],
              truncated: false,
            },
          },
        ],
      })
      expect(history.text).not.toContain("PRIVATE_")
      expect(history.data).not.toHaveProperty("selectedConversation")
      expect(Buffer.byteLength(history.text)).toBeLessThanOrEqual(256 * 1024)
      if (history.data.state !== "loaded" || !history.data.nextCursor)
        throw new Error("Missing history continuation")
      const next = await f.get(
        `${route}?view=history&conversationId=${conversation.id}&limit=1&cursor=${encodeURIComponent(history.data.nextCursor)}`,
      )
      expect(next.status).toBe(200)
      expect(next.text).toContain("Private fixture message must stay hidden")
      expect(next.data.items[0]?.id).not.toBe(entry.id)
      const entries = await f.get(`${route}?view=entries&conversationId=${conversation.id}`)
      expect(entries.status).toBe(200)
      expect(entries.data.items.every((item) => !("content" in item))).toBe(true)
      expect(entries.text).not.toContain("Saved addressed input")
      const detail = await f.get(
        `${route}?view=entries&conversationId=${conversation.id}&objectId=${entry.id}`,
      )
      const deepLink = await f.get(
        `${route}?view=history&conversationId=${conversation.id}&objectId=${entry.id}`,
      )
      expect(detail.status).toBe(200)
      expect(deepLink.status).toBe(200)
      expect(detail.data.items).toEqual(history.data.items)
      expect(deepLink.data.items).toEqual(detail.data.items)
      expect(await session.harness.inspect(context)).toEqual(before)
      expect(commits).not.toHaveBeenCalled()
      expect(f.fixture.requests).toEqual([])
      expect(f.create).toHaveBeenCalledOnce()
    } finally {
      unsubscribe()
    }
  })

  it("returns persisted off-page selection separately from URL inspection target without mutation", async () => {
    const f = await setup()
    const session = await f.loaded()
    const root = await currentConversation(session)
    const selected = await session.harness.createConversation(
      { ownership: { kind: "ownerless" } },
      context,
    )
    await session.harness.commit(async (tx) => {
      ;(await tx.doc(BotSessionDoc)).activeConversation = selected.id
    }, context)
    const before = await session.harness.inspect(context)
    const commits = vi.fn()
    const unsubscribe = session.harness.subscribeCommits(commits)
    try {
      const page = await f.get(`${route}?limit=1`)
      expect(page.status).toBe(200)
      expect(page.data).toMatchObject({
        state: "loaded",
        items: [{ id: root.id, active: false }],
        selectedConversation: { id: selected.id, active: true },
      })
      const direct = await f.get(`${route}?objectId=${root.id}`)
      expect(direct.data).toMatchObject({
        items: [{ id: root.id, active: false }],
        selectedConversation: { id: selected.id, active: true },
      })
      const tasks = await f.get(`${route}?view=tasks&conversationId=${selected.id}`)
      expect(tasks.status).toBe(200)
      expect(tasks.data.items).toEqual([])
      expect(tasks.data).not.toHaveProperty("selectedConversation")
      expect(await session.harness.inspect(context)).toEqual(before)
      expect(commits).not.toHaveBeenCalled()
      expect(f.create).toHaveBeenCalledOnce()
      expect(f.fixture.requests).toEqual([])
    } finally {
      unsubscribe()
    }
    await session.harness.commit(async (tx) => {
      ;(await tx.doc(BotSessionDoc)).activeConversation = 99999
    }, context)
    expect((await f.get(route)).data).toHaveProperty("selectedConversation", null)
    await session.harness.commit(async (tx) => {
      Reflect.deleteProperty(await tx.doc(BotSessionDoc), "activeConversation")
    }, context)
    expect((await f.get(route)).data).toHaveProperty("selectedConversation", null)
  })

  it("binds pagination to the chat and query and conceals read failures", async () => {
    const f = await setup()
    const session = await f.loaded()
    await f.loaded(456)
    for (let i = 0; i < 3; i++)
      await session.harness.createConversation({ ownership: { kind: "ownerless" } }, context)
    const first = await f.get(`${route}?limit=1`)
    if (first.data.state !== "loaded" || !first.data.nextCursor)
      throw new Error("Missing bounded cursor")
    const cursor = encodeURIComponent(first.data.nextCursor)
    expect((await f.get(`${route}?limit=1&cursor=${cursor}`)).status).toBe(200)
    expect((await f.get(`/api/chats/456/durable?limit=1&cursor=${cursor}`)).status).toBe(400)
    expect((await f.get(`${route}?limit=2&cursor=${cursor}`)).status).toBe(400)
    expect((await f.get(`${route}?limit=1&cursor=${cursor}broken`)).status).toBe(400)
    const read = vi
      .spyOn(session, "inspectDurable")
      .mockRejectedValueOnce(new Error("SELECT secret FROM /private/fixture.sqlite"))
    const failed = await f.get(route)
    expect(failed.status).toBe(500)
    expect(failed.text).not.toMatch(/SELECT|secret|private|sqlite/)
    read.mockRestore()
    expect((await f.get(route)).status).toBe(200)
  })

  it.each(["revoked", "expired"] as const)(
    "does not deliver a result after the admin session is %s",
    async (condition) => {
      const f = await setup()
      const session = await f.loaded()
      const entered = deferred()
      const gate = deferred()
      const original = session.inspectDurable.bind(session)
      let signal: AbortSignal | undefined
      const read = vi
        .spyOn(session, "inspectDurable")
        .mockImplementation(async (query, currentSignal) => {
          signal = currentSignal
          entered.resolve()
          await gate.promise
          return original(query, currentSignal)
        })
      if (condition === "expired") f.expireSoon()
      const pending = f.get(route)
      try {
        await entered.promise
        if (condition === "revoked") f.revoke()
        else await vi.waitFor(() => expect(signal?.aborted).toBe(true))
        gate.resolve()
        const result = await pending
        expect(result.status).toBe(401)
        expect(result.text).not.toContain('"items"')
      } finally {
        gate.resolve()
        await pending
        read.mockRestore()
      }
      f.relogin()
      expect((await f.get(route)).status).toBe(200)
    },
  )

  it("cancels disconnected reads and server shutdown without sending stale data", async () => {
    const f = await setup()
    const session = await f.loaded()
    let signal: AbortSignal | undefined
    let entered = deferred()
    let gate = deferred()
    const original = session.inspectDurable.bind(session)
    const read = vi
      .spyOn(session, "inspectDurable")
      .mockImplementation(async (query, currentSignal) => {
        signal = currentSignal
        entered.resolve()
        await gate.promise
        return original(query, currentSignal)
      })
    const pending = f.call(route)
    const disconnected = pending.promise.catch(() => undefined)
    await entered.promise
    pending.destroy()
    await vi.waitFor(() => expect(signal?.aborted).toBe(true))
    gate.resolve()
    await disconnected
    read.mockRestore()
    await vi.waitFor(async () => expect((await f.get(route)).status).toBe(200))

    entered = deferred()
    gate = deferred()
    const secondRead = vi
      .spyOn(session, "inspectDurable")
      .mockImplementation(async (query, currentSignal) => {
        signal = currentSignal
        entered.resolve()
        await gate.promise
        return original(query, currentSignal)
      })
    const second = f.get(route)
    await entered.promise
    const stopping = f.server.stop()
    await vi.waitFor(() => expect(signal?.aborted).toBe(true))
    gate.resolve()
    expect((await second).status).toBe(503)
    await stopping
    secondRead.mockRestore()
  })
})
