import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import type { DurableInspectionQuery } from "@narumitw/sumire-contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DurableSession } from "../src/agent/durable-session.js"
import { BotSessionDoc, OutboxDoc } from "../src/agent/durable-state.js"
import { McpCapability } from "../src/agent/mcp-capability.js"
import { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

const cleanups: Array<() => Promise<void>> = []
const gates: Array<() => void> = []
const conversations: DurableInspectionQuery = { view: "conversations", limit: 25 }
const signal = () => new AbortController().signal

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  gates.push(resolve)
  return { promise, resolve }
}

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve))

afterEach(async () => {
  // A failed assertion must not leave an intentionally uncooperative read holding storage open.
  for (const release of gates.splice(0)) release()
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  } finally {
    vi.restoreAllMocks()
  }
})

async function setup(overrides: Parameters<typeof createPiFixture>[0] = {}) {
  const fixture = await createPiFixture(overrides)
  cleanups.push(() => fixture.cleanup())
  const create = vi.fn((chatId: number) => fixture.createSession(chatId))
  const registry = new ChatSessionRegistry(
    create,
    fixture.settings.botSessionLogDir,
    fixture.logger,
    { control: fixture.factory.control },
  )
  cleanups.push(() => registry.dispose())
  return { fixture, registry, create }
}

/** Delay a native call, or delay its completed result, without obeying cancellation. */
function gateInspection(session: DurableSession, returnStaleResult = false) {
  const entered = deferred()
  const release = deferred()
  const original = vi.fn(session.inspectDurable.bind(session))
  let readSignal: AbortSignal | undefined
  vi.spyOn(session, "inspectDurable").mockImplementationOnce(async (query, abortSignal) => {
    readSignal = abortSignal
    const result = returnStaleResult ? await original(query, abortSignal) : undefined
    entered.resolve()
    await release.promise
    return result ?? original(query, abortSignal)
  })
  return {
    entered,
    release,
    original,
    get signal() {
      return readSignal
    },
  }
}

function observe<T>(promise: Promise<T>) {
  let settled = false
  const outcome = promise.then(
    (value) => {
      settled = true
      return { value, error: undefined }
    },
    (error: unknown) => {
      settled = true
      return { value: undefined, error }
    },
  )
  return {
    outcome,
    get settled() {
      return settled
    },
  }
}

async function loadOwner(f: Awaited<ReturnType<typeof setup>>, chatId = 123) {
  await f.registry.appendPassiveContext(chatId, "Seed context before the inspection baseline.")
  const session = await f.create.mock.results.at(-1)?.value
  if (!session) throw new Error("Missing loaded fixture owner")
  return session
}

describe("durable inspection owner lifecycle", () => {
  it("does not create unloaded chats or wait for a bot's actual factory creation", async () => {
    const f = await setup()
    await expect(f.registry.inspectDurable(123, conversations, signal())).resolves.toMatchObject({
      version: 1,
      state: "not-loaded",
      view: "conversations",
      items: [],
      truncated: false,
    })
    expect(f.create).not.toHaveBeenCalled()
    expect(await f.fixture.factory.listChats()).toEqual([])

    const entered = deferred()
    const release = deferred()
    const checkAuth = f.fixture.modelRuntime.checkAuth.bind(f.fixture.modelRuntime)
    vi.spyOn(f.fixture.modelRuntime, "checkAuth").mockImplementationOnce(async (provider) => {
      entered.resolve()
      await release.promise
      return checkAuth(provider)
    })
    const opening = f.registry.appendPassiveContext(123, "An ordinary bot input opens the owner.")
    await entered.promise
    expect(f.create).toHaveBeenCalledOnce()
    const pendingRead = observe(f.registry.inspectDurable(123, conversations, signal()))
    await nextTick()
    expect(pendingRead.settled).toBe(true)
    expect(await pendingRead.outcome).toMatchObject({ value: { state: "not-loaded", items: [] } })
    expect(f.create).toHaveBeenCalledOnce()
    release.resolve()
    await opening
    await expect(f.registry.inspectDurable(123, conversations, signal())).resolves.toMatchObject({
      state: "loaded",
    })
  })

  it("treats a loaded handle without the optional inspection method as unavailable without creating another owner", async () => {
    const f = await setup()
    const session = await loadOwner(f)
    Object.defineProperty(session, "inspectDurable", { value: undefined, configurable: true })
    const abort = vi.spyOn(session, "abort")
    await expect(f.registry.inspectDurable(123, conversations, signal())).resolves.toMatchObject({
      state: "not-loaded",
      items: [],
    })
    expect(f.create).toHaveBeenCalledOnce()
    expect(abort).not.toHaveBeenCalled()
  })

  it("reads a loaded idle Pi owner without commits, model requests, tools, MCP discovery, or delivery", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sumire-inspection-effects-"))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const config = path.join(directory, "mcp.json")
    const trace = path.join(directory, "discovery.txt")
    await writeFile(
      config,
      JSON.stringify({
        mcpServers: {
          fake: {
            command: process.execPath,
            args: [new URL("./fixtures/mcp-server.mjs", import.meta.url).pathname],
            exposure: "direct",
            env: { MCP_TEST_TOOLS: "echo", MCP_TEST_LIST_TRACE: trace },
          },
        },
      }),
    )
    const ready = vi.spyOn(McpCapability.prototype, "ready")
    const f = await setup({ botMcpConfigPath: config })
    const session = await f.fixture.createSession()
    f.create.mockResolvedValueOnce(session)
    const toolEvents: string[] = []
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start") toolEvents.push(event.toolName)
    })
    const recover = vi.spyOn(session, "recoverPending")
    const acknowledge = vi.spyOn(session, "acknowledge")
    const abort = vi.spyOn(session, "abort")
    const deliver = vi.fn(async () => true)
    f.fixture.enqueue("mcp__fake__echo", { value: "Seed an actual tool call before the baseline." })
    await f.registry.submit(123, "Seed durable records.", {
      delivery: { sourceMessageId: 1, mode: "default" },
    })
    await session.waitForIdle()
    expect(session.isIdle).toBe(true)
    expect(toolEvents).toContain("mcp__fake__echo")
    expect(ready.mock.calls.length).toBeGreaterThan(0)
    expect(await session.hasPendingResponses()).toBe(true)
    const snapshot = async () =>
      JSON.stringify({
        session: await session.harness.snapshot(BotSessionDoc, context),
        outbox: await session.harness.snapshot(OutboxDoc, context),
        entries: session.entries,
        checkpoint: session.getCheckpoint(),
      })
    const before = await snapshot()
    const baseline = {
      models: f.fixture.requests.length,
      tools: toolEvents.length,
      mcp: ready.mock.calls.length,
      discovery: await readFile(trace, "utf8"),
    }
    const commits = vi.fn()
    const unsubscribeCommits = session.harness.subscribeCommits(commits)
    const auth = vi.spyOn(f.fixture.modelRuntime, "checkAuth")
    try {
      const result = await f.registry.inspectDurable(123, conversations, signal())
      expect(result).toMatchObject({
        state: "loaded",
        items: [expect.objectContaining({ active: true })],
      })
      const active = result.items.find((item) => item.type === "conversation" && item.active)
      if (!active) throw new Error("Missing active conversation")
      const requests: DurableInspectionQuery[] = [
        { view: "tasks", conversationId: active.id, limit: 25 },
        { view: "entries", conversationId: active.id, limit: 25 },
        { view: "documents", scope: "session", limit: 25 },
        { view: "documents", scope: "conversation", conversationId: active.id, limit: 25 },
      ]
      for (const query of requests) {
        const page = await f.registry.inspectDurable(123, query, signal())
        expect(page.state).toBe("loaded")
        for (const item of page.items) {
          if (item.type === "document" && item.valueState === "metadata-only") {
            await expect(
              f.registry.inspectDurable(123, { ...query, objectId: item.id }, signal()),
            ).resolves.toMatchObject({
              state: "loaded",
              items: [expect.objectContaining({ valueState: "available" })],
            })
          }
        }
      }
      await f.registry.recover([], deliver)
      await nextTick()
      expect(await snapshot()).toBe(before)
      expect(commits).not.toHaveBeenCalled()
      expect(f.fixture.requests).toHaveLength(baseline.models)
      expect(toolEvents).toHaveLength(baseline.tools)
      expect(ready).toHaveBeenCalledTimes(baseline.mcp)
      expect(await readFile(trace, "utf8")).toBe(baseline.discovery)
      expect(auth).not.toHaveBeenCalled()
      expect(recover).not.toHaveBeenCalled()
      expect(acknowledge).not.toHaveBeenCalled()
      expect(deliver).not.toHaveBeenCalled()
      expect(abort).not.toHaveBeenCalled()
      expect(f.create).toHaveBeenCalledOnce()
    } finally {
      unsubscribeCommits()
      unsubscribe()
    }
  })

  it("admits one read per chat while different loaded chats can read concurrently", async () => {
    const f = await setup()
    const first = await loadOwner(f, 123)
    const second = await loadOwner(f, 456)
    const firstGate = gateInspection(first)
    const secondGate = gateInspection(second)
    const one = f.registry.inspectDurable(123, conversations, signal())
    await firstGate.entered.promise
    await expect(f.registry.inspectDurable(123, conversations, signal())).rejects.toMatchObject({
      status: 409,
    })
    const two = f.registry.inspectDurable(456, conversations, signal())
    await secondGate.entered.promise
    expect(firstGate.original).not.toHaveBeenCalled()
    expect(secondGate.original).not.toHaveBeenCalled()
    secondGate.release.resolve()
    await expect(two).resolves.toMatchObject({ state: "loaded" })
    await expect(f.registry.inspectDurable(456, conversations, signal())).resolves.toMatchObject({
      state: "loaded",
    })
    await expect(f.registry.inspectDurable(123, conversations, signal())).rejects.toMatchObject({
      status: 409,
    })
    firstGate.release.resolve()
    await expect(one).resolves.toMatchObject({ state: "loaded" })
    await expect(f.registry.inspectDurable(123, conversations, signal())).resolves.toMatchObject({
      state: "loaded",
    })
    expect(f.create).toHaveBeenCalledTimes(2)
  })

  it("retains the lease after client abort until an uncooperative await ends and the native read fails", async () => {
    const f = await setup()
    const session = await loadOwner(f)
    const abort = vi.spyOn(session, "abort")
    const dispose = vi.spyOn(session, "dispose")
    const gate = gateInspection(session)
    const client = new AbortController()
    const read = observe(f.registry.inspectDurable(123, conversations, client.signal))
    await gate.entered.promise
    client.abort()
    await nextTick()
    expect(gate.signal?.aborted).toBe(true)
    expect(read.settled).toBe(false)
    expect(gate.original).not.toHaveBeenCalled()
    await expect(f.registry.inspectDurable(123, conversations, signal())).rejects.toMatchObject({
      status: 409,
    })
    gate.release.resolve()
    expect(await read.outcome).toMatchObject({ value: undefined, error: { status: 409 } })
    expect(gate.original).toHaveBeenCalledOnce()
    await expect(gate.original.mock.results[0]?.value).rejects.toBeDefined()
    await expect(f.registry.inspectDurable(123, conversations, signal())).resolves.toMatchObject({
      state: "loaded",
    })
    expect(abort).not.toHaveBeenCalled()
    expect(dispose).not.toHaveBeenCalled()
  })

  it("releases a failed read and rejects pre-aborted requests without aborting the owner", async () => {
    const f = await setup()
    const session = await loadOwner(f)
    const abort = vi.spyOn(session, "abort")
    const failure = new Error("Fixture read failure")
    const inspect = vi.spyOn(session, "inspectDurable").mockRejectedValueOnce(failure)
    await expect(f.registry.inspectDurable(123, conversations, signal())).rejects.toBe(failure)
    const client = new AbortController()
    client.abort()
    await expect(f.registry.inspectDurable(123, conversations, client.signal)).rejects.toBeDefined()
    expect(inspect).toHaveBeenCalledOnce()
    await expect(f.registry.inspectDurable(123, conversations, signal())).resolves.toMatchObject({
      state: "loaded",
    })
    expect(abort).not.toHaveBeenCalled()
    expect(f.create).toHaveBeenCalledOnce()
  })

  it("uses the existing owner for bot input during inspection and does not abort agent work when the read is cancelled", async () => {
    const f = await setup()
    const session = await loadOwner(f)
    const abort = vi.spyOn(session, "abort")
    const gate = gateInspection(session)
    const client = new AbortController()
    const read = observe(f.registry.inspectDurable(123, conversations, client.signal))
    await gate.entered.promise
    const releaseModel = f.fixture.pauseNextRequest()
    gates.push(releaseModel)
    f.fixture.enqueueAnswer("Agent work survives inspection cancellation.")
    const submission = f.registry.submit(123, "Normal bot input while inspection is waiting.")
    await vi.waitFor(() => expect(f.fixture.requests).toHaveLength(1))
    expect(f.create).toHaveBeenCalledOnce()
    expect(session.isStreaming).toBe(true)
    client.abort()
    gate.release.resolve()
    expect(await read.outcome).toMatchObject({ error: { status: 409 } })
    expect(abort).not.toHaveBeenCalled()
    expect(session.isStreaming).toBe(true)
    await expect(f.registry.inspectDurable(123, conversations, signal())).resolves.toMatchObject({
      state: "loaded",
    })
    releaseModel()
    await expect(submission).resolves.toMatchObject({
      kind: "completed",
      text: "Agent work survives inspection cancellation.",
    })
    expect(f.create).toHaveBeenCalledOnce()
    expect(abort).not.toHaveBeenCalled()
  })

  it.each(["reset", "policy", "shutdown"] as const)(
    "%s cancels reads, waits before owner disposal, and discards a stale successful result",
    async (operation) => {
      const f = await setup()
      const session = await loadOwner(f)
      const dispose = vi.spyOn(session, "dispose")
      const abort = vi.spyOn(session, "abort")
      const gate = gateInspection(session, true)
      const read = observe(f.registry.inspectDurable(123, conversations, signal()))
      await gate.entered.promise
      const changing = observe(
        operation === "reset"
          ? f.registry.reset(123)
          : operation === "policy"
            ? f.registry.invalidatePolicies()
            : f.registry.dispose(),
      )
      await nextTick()
      expect(gate.signal?.aborted).toBe(true)
      expect(read.settled).toBe(false)
      expect(changing.settled).toBe(false)
      expect(dispose).not.toHaveBeenCalled()
      expect(abort).not.toHaveBeenCalled()
      await expect(f.registry.inspectDurable(123, conversations, signal())).rejects.toMatchObject({
        status: 409,
      })
      gate.release.resolve()
      expect(await read.outcome).toMatchObject({ value: undefined, error: { status: 409 } })
      expect(await changing.outcome).toEqual({ value: undefined, error: undefined })
      expect(dispose).toHaveBeenCalledOnce()
      if (operation === "shutdown") {
        expect(abort).not.toHaveBeenCalled()
        await expect(f.registry.inspectDurable(123, conversations, signal())).rejects.toMatchObject(
          { status: 409 },
        )
        await f.registry.dispose()
        expect(dispose).toHaveBeenCalledOnce()
      } else {
        await expect(
          f.registry.inspectDurable(123, conversations, signal()),
        ).resolves.toMatchObject({ state: "not-loaded" })
        await f.registry.appendPassiveContext(123, "New input after ownership changes.")
        await expect(
          f.registry.inspectDurable(123, conversations, signal()),
        ).resolves.toMatchObject({ state: "loaded" })
        expect(f.create).toHaveBeenCalledTimes(2)
      }
    },
  )

  it("cancels and drains a recovery-only owner's read before close and blocks a second owner until close ends", async () => {
    const f = await setup()
    const session = await f.fixture.createSession()
    f.fixture.enqueueAnswer("A pending Telegram response.")
    await session.prompt("Seed recovery before the inspection baseline.", {
      delivery: { sourceMessageId: 2, mode: "default" },
    })
    expect(await session.hasPendingResponses()).toBe(true)
    f.create.mockResolvedValueOnce(session)
    const recovering = deferred()
    const finishRecovery = deferred()
    const recover = session.recoverPending.bind(session)
    vi.spyOn(session, "recoverPending").mockImplementationOnce(async (deliver) => {
      recovering.resolve()
      await finishRecovery.promise
      await recover(deliver)
    })
    const closing = deferred()
    const finishClose = deferred()
    const close = session.dispose.bind(session)
    const dispose = vi.spyOn(session, "dispose").mockImplementationOnce(async () => {
      closing.resolve()
      await finishClose.promise
      await close()
    })
    const abort = vi.spyOn(session, "abort")
    const deliver = vi.fn(async () => true)
    await f.registry.recover([123], deliver)
    await recovering.promise
    const gate = gateInspection(session, true)
    const read = observe(f.registry.inspectDurable(123, conversations, signal()))
    await gate.entered.promise
    finishRecovery.resolve()
    await vi.waitFor(() => expect(gate.signal?.aborted).toBe(true))
    expect(deliver).toHaveBeenCalledOnce()
    expect(dispose).not.toHaveBeenCalled()
    expect(read.settled).toBe(false)
    f.fixture.enqueueAnswer("New work after the old database owner closes.")
    const submission = observe(f.registry.submit(123, "New bot input races recovery eviction."))
    await nextTick()
    expect(f.create).toHaveBeenCalledOnce()
    expect(submission.settled).toBe(false)
    await expect(f.registry.inspectDurable(123, conversations, signal())).rejects.toMatchObject({
      status: 409,
    })
    gate.release.resolve()
    expect(await read.outcome).toMatchObject({ value: undefined, error: { status: 409 } })
    await closing.promise
    expect(dispose).toHaveBeenCalledOnce()
    await nextTick()
    expect(f.create).toHaveBeenCalledOnce()
    expect(submission.settled).toBe(false)
    expect(abort).not.toHaveBeenCalled()
    finishClose.resolve()
    expect(await submission.outcome).toMatchObject({
      value: { kind: "completed", text: "New work after the old database owner closes." },
    })
    expect(f.create).toHaveBeenCalledTimes(2)
    const replacement = await f.create.mock.results[1]?.value
    expect(replacement).not.toBe(session)
    expect(replacement?.sessionId).toBe(session.sessionId)
    await expect(f.registry.inspectDurable(123, conversations, signal())).resolves.toMatchObject({
      state: "loaded",
    })
    expect(abort).not.toHaveBeenCalled()
  })
})
