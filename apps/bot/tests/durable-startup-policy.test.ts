import { randomUUID } from "node:crypto"
import { access } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import { type JsonObject, Type } from "@earendil-works/pi-ai"
import {
  AssistantEntry,
  type Conversation,
  GenerationTask,
  Harness,
  ToolTask,
} from "@earendil-works/pi-durable"
import { createUrlTool } from "@narumitw/sumire-pi-url-reader"
import { afterEach, describe, expect, it, vi } from "vitest"
import { chatModelRuntime } from "../src/admin/providers.js"
import { DurableSession } from "../src/agent/durable/session.js"
import { OutboxDoc, ProgressDoc } from "../src/agent/durable/state.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

vi.mock("@narumitw/sumire-pi-url-reader", { spy: true })

const fixtures: Awaited<ReturnType<typeof createPiFixture>>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
})

async function setup() {
  const effect = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "effect" }],
    details: { code: "unknown" as const, attempts: [] },
  }))
  vi.mocked(createUrlTool).mockReturnValue({
    name: "read_url_content",
    label: "Fixture capability",
    description: "Record a fixture capability side effect",
    parameters: Type.Object({ url: Type.String() }),
    execute: effect,
  })
  const fixture = await createPiFixture()
  fixtures.push(fixture)
  return { fixture, effect }
}

async function pendingTool(
  session: DurableSession,
  conversation: Conversation,
  name: string,
  args: JsonObject,
) {
  return conversation.commit(async (tx) => {
    const callId = randomUUID()
    const assistant = await tx.appendEntry(AssistantEntry, conversation.id, {
      model: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: callId, name, arguments: args }],
          api: session.model.api,
          provider: session.model.provider,
          model: session.model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: Date.now(),
        },
      ],
    })
    return tx.createTask(
      ToolTask,
      { kind: "model", assistant: assistant.id, callId },
      { ownership: { kind: "conversation" } },
    )
  }, context)
}

/** Keep the real scheduler running between the first abort and the remaining scope cancellations. */
function slowFirstCancellation() {
  const open = Harness.open
  vi.spyOn(Harness, "open").mockImplementationOnce(async (...args) => {
    const harness = await open(...args)
    const conversation = harness.conversation.bind(harness)
    let delayed = false
    vi.spyOn(harness, "conversation").mockImplementation(async (...lookup) => {
      const handle = await conversation(...lookup)
      if (!handle) return handle
      const abort = handle.abort.bind(handle)
      handle.abort = async (...options) => {
        await abort(...options)
        if (!delayed) {
          delayed = true
          await delay(100)
        }
      }
      return handle
    })
    return harness
  })
}

describe("durable startup admission", () => {
  it("blocks still-permitted capabilities and model HTTP requests until all old scopes are cancelled", async () => {
    const { fixture, effect } = await setup()
    const session = await fixture.createSession()
    expect((await session.harness.inspect(context)).scheduling).toBe("paused")
    // Put pending work beyond the first scan page, after many archived ownerless scopes.
    let last = await session.harness.root(context)
    for (let index = 0; index < 105; index++)
      last = await session.harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: { model: { provider: session.model.provider, modelId: session.model.id } },
        },
        context,
      )
    const output = path.join(fixture.root, "must-not-write.txt")
    await pendingTool(session, last, "write", { path: output, content: "legacy effect" })
    await pendingTool(session, last, "read_url_content", { url: "https://example.com/" })
    await pendingTool(session, last, "codemode", {
      code: 'await tools.read_url_content({url: "https://example.com/"}); console.log("legacy script");',
    })
    await pendingTool(session, last, "update_progress", {
      steps: [{ text: "legacy progress", status: "in_progress" }],
    })
    await last.commit(async (tx) => {
      await tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" } })
      ;(await tx.doc(OutboxDoc)).pending.push({
        requestId: "legacy-delivery",
        conversationId: last.id,
        content: "legacy input",
        delivery: { sourceMessageId: 1, mode: "default" },
      })
    }, context)
    expect((await session.harness.inspect(context)).scheduling).toBe("paused")
    await session.dispose()
    const store = fixture.factory.control
    const state = store.snapshot()
    store.save(state.policy, state.revision, "7")
    store.applied(state.revision + 1, true)
    // The capabilities and model are still allowed. Only the trust epoch changed.
    expect(store.allowsTool(123, "write")).toBe(true)
    expect(store.allowsTool(123, "read_url_content")).toBe(true)
    slowFirstCancellation()
    const reopened = await fixture.createSession()
    await reopened.harness.waitForIdle(context)
    expect(effect).not.toHaveBeenCalled()
    await expect(access(output)).rejects.toThrow()
    expect(fixture.requests).toEqual([])
    expect((await reopened.harness.snapshot(OutboxDoc, context))?.pending).toEqual([])
    expect((await reopened.harness.snapshot(ProgressDoc, last.id, context))?.steps ?? []).toEqual(
      [],
    )
    expect((await reopened.harness.inspect(context)).tasks).toEqual([])
    // New work is admitted only after restoration is complete.
    fixture.enqueueAnswer("New authorized response")
    expect(await reopened.prompt("new request")).toMatchObject({ text: "New authorized response" })
  })

  it("blocks a prepared model request in the last old scope during cancellation", async () => {
    const { fixture } = await setup()
    const session = await fixture.createSession()
    let last = await session.harness.root(context)
    for (let index = 0; index < 105; index++)
      last = await session.harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: { model: { provider: session.model.provider, modelId: session.model.id } },
        },
        context,
      )
    const release = fixture.pauseNextRequest()
    try {
      await last.submit({ type: "input", content: "legacy model request" }, context)
      await vi.waitFor(() => expect(fixture.requests).toHaveLength(1))
      await session.dispose()
      await vi.waitFor(() => expect(fixture.disconnectedRequests).toBe(1))
      release()
      const store = fixture.factory.control
      const state = store.snapshot()
      store.save(state.policy, state.revision, "7")
      store.applied(state.revision + 1, true)
      slowFirstCancellation()
      const reopened = await fixture.createSession()
      await reopened.harness.waitForIdle(context)
      expect(fixture.requests).toHaveLength(1)
      expect((await reopened.harness.inspect(context)).tasks).toEqual([])
    } finally {
      release()
    }
  })

  it("resumes unchanged-trust pending capabilities and model work normally", async () => {
    const { fixture, effect } = await setup()
    const session = await fixture.createSession()
    const root = await session.harness.root(context)
    await pendingTool(session, root, "read_url_content", { url: "https://example.com/" })
    await root.commit(
      (tx) => tx.createTask(GenerationTask, {}, { ownership: { kind: "conversation" } }),
      context,
    )
    await session.dispose()
    fixture.enqueueAnswer("Resumed response")
    const reopened = await fixture.createSession()
    await reopened.harness.waitForIdle(context)
    expect(effect).toHaveBeenCalledTimes(1)
    expect(fixture.requests).toHaveLength(1)
  })

  it("keeps admission independent for each chat and guards direct native capability execution", async () => {
    const { fixture, effect } = await setup()
    const first = await fixture.createSession(123)
    const original = DurableSession.open
    let openingSession: DurableSession | undefined
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const opening = vi.spyOn(DurableSession, "open").mockImplementation(async (options) => {
      const result = await original(options)
      openingSession = result
      entered()
      await gate
      return result
    })
    const pending = fixture.createSession(456)
    try {
      await started
      if (!openingSession) throw new Error("Missing opening session")
      const blocked = openingSession.nativeTools.find((tool) => tool.name === "read_url_content")
      if (!blocked) throw new Error("Missing opening capability")
      await expect(async () =>
        blocked.execute("blocked-direct", {}, undefined, undefined, undefined as never),
      ).rejects.toThrow("startup admission")
      expect(() =>
        openingSession?.modelRuntime.completeSimple(openingSession.model, { messages: [] }),
      ).toThrow("startup admission")
      expect(effect).not.toHaveBeenCalled()
      expect(fixture.requests).toEqual([])
      const tool = first.nativeTools.find((tool) => tool.name === "read_url_content")
      if (!tool) throw new Error("Missing fixture capability")
      await tool.execute("direct-fixture", {}, undefined, undefined, undefined as never)
      expect(effect).toHaveBeenCalledTimes(1)
      fixture.enqueueAnswer("Other chat remains ready")
      await first.prompt("ready chat")
      expect(fixture.requests).toHaveLength(1)
    } finally {
      release()
      await pending
      opening.mockRestore()
    }
  })

  it("checks runtime admission for generation and completeSimple before any HTTP request", async () => {
    const { fixture } = await setup()
    const session = await fixture.createSession()
    let ready = false
    const assertAdmission = vi.fn(() => {
      if (!ready) throw new Error("Startup blocked")
    })
    const runtime = chatModelRuntime(
      fixture.modelRuntime,
      fixture.factory.control,
      123,
      assertAdmission,
    )
    expect(() => runtime.streamSimple(session.model, { messages: [] })).toThrow("Startup blocked")
    expect(() => runtime.completeSimple(session.model, { messages: [] })).toThrow("Startup blocked")
    expect(fixture.requests).toEqual([])
    ready = true
    fixture.enqueueAnswer("Admitted")
    expect(await runtime.completeSimple(session.model, { messages: [] })).toMatchObject({
      content: [{ type: "text", text: "Admitted" }],
    })
    expect(assertAdmission).toHaveBeenCalledTimes(3)
    expect(fixture.requests).toHaveLength(1)
  })
})
