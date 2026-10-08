import { spawn } from "node:child_process"
import { once } from "node:events"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import { afterEach, describe, expect, it, vi } from "vitest"
import { OutboxDoc } from "../src/agent/durable-state.js"
import { createPiSessionFactory } from "../src/agent/pi-session-factory.js"
import { TelegramReplyIndex } from "../src/agent/reply-index.js"
import { asSessionCreator, ChatSessionRegistry } from "../src/agent/session-registry.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

const fixtures: Awaited<ReturnType<typeof createPiFixture>>[] = []
const setup = async () => {
  const fixture = await createPiFixture()
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
})

describe("durable bot runtime", () => {
  it("reopens the same chat identity and transcript, accepts images, and keeps storage private", async () => {
    const fixture = await setup()
    const session = await fixture.createSession()
    const image = { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" }
    fixture.enqueueAnswer("First answer")
    expect(await session.prompt("look at this", { images: [image] })).toMatchObject({
      text: "First answer",
    })
    expect(JSON.stringify(fixture.requests[0]?.messages)).toContain(
      "data:image/png;base64,aGVsbG8=",
    )
    const id = session.sessionId
    const directory = path.dirname(session.sessionFile)
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    expect((await stat(session.sessionFile)).mode & 0o777).toBe(0o600)
    await session.dispose()
    expect(await fixture.factory.listChats()).toEqual([123])
    const reopened = await fixture.createSession()
    expect(reopened.sessionId).toBe(id)
    expect(JSON.stringify(reopened.messages)).toContain("First answer")
    fixture.enqueueAnswer("Next answer")
    await reopened.prompt("continue")
    expect(JSON.stringify(fixture.requests[1]?.messages)).toContain("look at this")
  })

  it("acknowledges delivered responses even when reply-tree routing is disabled", async () => {
    const fixture = await setup()
    const session = await fixture.createSession()
    const registry = new ChatSessionRegistry(
      async () => session,
      fixture.settings.botSessionLogDir,
      fixture.logger,
    )
    try {
      fixture.enqueueAnswer("Answer")
      const result = await registry.submit(123, "question", {
        delivery: { sourceMessageId: 11, statusMessageId: 12, mode: "default" },
      })
      expect((await session.harness.snapshot(OutboxDoc, context))?.pending).toHaveLength(1)
      if (result.kind !== "completed") throw new Error("Missing answer")
      await registry.recordDelivery(123, result.checkpoint, [12])
      expect((await session.harness.snapshot(OutboxDoc, context))?.pending).toEqual([])
    } finally {
      await registry.dispose()
    }
  })

  it("resumes an interrupted model request and recovers its saved Telegram delivery without duplicating input", async () => {
    const fixture = await setup()
    const session = await fixture.createSession()
    const release = fixture.pauseNextRequest()
    fixture.enqueueAnswer("Recovered response")
    const pending = session
      .prompt("persisted input", {
        delivery: { sourceMessageId: 21, statusMessageId: 22, mode: "publish" },
      })
      .catch(() => undefined)
    try {
      await vi.waitFor(() => expect(fixture.requests).toHaveLength(1))
      await session.dispose()
      await pending
      await vi.waitFor(() => expect(fixture.disconnectedRequests).toBe(1))
      release()
      const reopened = await fixture.createSession()
      const delivered: string[] = []
      await reopened.recoverPending(async (answer, delivery) => {
        expect(delivery).toEqual({ sourceMessageId: 21, statusMessageId: 22, mode: "publish" })
        expect(answer.entryId).toBeDefined()
        delivered.push(answer.text)
        if (answer.requestId) await reopened.acknowledge(answer.requestId)
      })
      expect(delivered).toEqual(["Recovered response"])
      expect(reopened.messages.filter((message) => message.role === "user")).toHaveLength(1)
      expect((await reopened.harness.snapshot(OutboxDoc, context))?.pending).toEqual([])
    } finally {
      release()
    }
  })

  it("recovers committed input and delivery after the process is killed", async () => {
    const fixture = await setup()
    const release = fixture.pauseNextRequest()
    fixture.enqueueAnswer("Recovered after SIGKILL")
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        new URL("./fixtures/durable-crash.mjs", import.meta.url).pathname,
        fixture.root,
        fixture.endpoint,
      ],
      { stdio: "pipe" },
    )
    let stderr = ""
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    const exited = once(child, "exit")
    try {
      await vi.waitFor(
        () => {
          expect(child.exitCode, stderr).toBeNull()
          expect(fixture.requests).toHaveLength(1)
        },
        // Process imports compete with the expanded real-transport suite on CI workers.
        // This bounds startup only; the committed-input/recovery assertions below are unchanged.
        { timeout: 10_000 },
      )
      child.kill("SIGKILL")
      await exited
      await vi.waitFor(() => expect(fixture.disconnectedRequests).toBe(1))
      release()
      const reopened = await fixture.createSession()
      const deliver = vi.fn(async () => {})
      await reopened.recoverPending(deliver)
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Recovered after SIGKILL" }),
        { sourceMessageId: 71, statusMessageId: 72, mode: "default" },
      )
      expect(reopened.messages.filter((message) => message.role === "user")).toHaveLength(1)
    } finally {
      release()
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await exited
    }
  })

  it("retains an undelivered completed answer across restart without making another model request", async () => {
    const fixture = await setup()
    const session = await fixture.createSession()
    fixture.enqueueAnswer("Already committed")
    await session.prompt("question", { delivery: { sourceMessageId: 31, mode: "default" } })
    await session.dispose()
    const reopened = await fixture.createSession()
    const deliver = vi.fn(async () => {})
    await reopened.recoverPending(deliver)
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ text: "Already committed" }), {
      sourceMessageId: 31,
      mode: "default",
    })
    expect(fixture.requests).toHaveLength(1)
    expect((await reopened.harness.snapshot(OutboxDoc, context))?.pending).toHaveLength(1)
  })

  it.each(["bash", "codemode"] as const)(
    "never replays an interrupted unsafe %s call",
    async (tool) => {
      const fixture = await setup()
      const session = await fixture.createSession()
      const command = "printf 'started\\n' >> counter.txt; sleep 30"
      fixture.enqueue(
        tool,
        tool === "bash"
          ? { command, timeout: 60 }
          : {
              code: `await tools.bash(${JSON.stringify({ command, timeout: 60 })})`,
            },
        false,
      )
      const pending = session
        .prompt("run once", { delivery: { sourceMessageId: 41, mode: "default" } })
        .catch(() => undefined)
      await vi.waitFor(async () =>
        expect(await readFile(path.join(fixture.root, "counter.txt"), "utf8")).toBe("started\n"),
      )
      await session.dispose()
      await pending
      fixture.enqueueAnswer("Interrupted tool handled")
      const reopened = await fixture.createSession()
      const answers: string[] = []
      await reopened.recoverPending(async (answer) => {
        answers.push(answer.text)
      })
      expect(answers).toEqual(["Interrupted tool handled"])
      expect(await readFile(path.join(fixture.root, "counter.txt"), "utf8")).toBe("started\n")
      const result = reopened.messages.find(
        (message) => message.role === "toolResult" && message.toolName === tool,
      )
      expect(result).toMatchObject({ isError: true })
    },
  )

  it("cancels persisted work before resuming when the whitelist changes", async () => {
    const fixture = await setup()
    const session = await fixture.createSession()
    const release = fixture.pauseNextRequest()
    fixture.enqueueAnswer("Unused fixture answer")
    const pending = session
      .prompt("old authorized request", {
        delivery: { sourceMessageId: 51, mode: "default" },
      })
      .catch(() => undefined)
    try {
      await vi.waitFor(() => expect(fixture.requests).toHaveLength(1))
      await session.dispose()
      await pending
      const changed = await createPiSessionFactory(
        { ...fixture.settings, botWhitelist: new Set([999]) },
        fixture.logger,
        undefined,
        fixture.modelRuntime,
      )
      const reopened = await changed.create(123)
      try {
        expect((await reopened.harness.snapshot(OutboxDoc, context))?.pending).toEqual([])
        await reopened.recoverPending(vi.fn())
        expect(fixture.requests).toHaveLength(1)
      } finally {
        await reopened.dispose()
      }
      // The abandoned HTTP request must not consume the fixture's queued reply.
      release()
      const next = await fixture.createSession()
      await next.prompt("new request")
    } finally {
      release()
    }
  })

  it.each(["steer", "followUp"] as const)(
    "delivers the final idle response after queued %s input",
    async (intent) => {
      const fixture = await setup()
      const session = await fixture.createSession()
      const release = fixture.pauseNextRequest()
      fixture.enqueueAnswer("Intermediate answer")
      fixture.enqueueAnswer("Final queued answer")
      const pending = session.prompt("first input", {
        delivery: { sourceMessageId: 81, mode: "default" },
      })
      try {
        await vi.waitFor(() => expect(fixture.requests).toHaveLength(1))
        await session[intent]("queued input")
        release()
        expect(await pending).toMatchObject({ text: "Final queued answer" })
        await session.dispose()
        const reopened = await fixture.createSession()
        const deliver = vi.fn(async () => {})
        await reopened.recoverPending(deliver)
        expect(deliver).toHaveBeenCalledWith(
          expect.objectContaining({ text: "Final queued answer" }),
          expect.anything(),
        )
        expect(fixture.requests).toHaveLength(2)
      } finally {
        release()
      }
    },
  )

  it("keeps an empty answer pending and recovers its fallback without another model request", async () => {
    const fixture = await setup()
    const session = await fixture.createSession()
    const registry = new ChatSessionRegistry(
      async () => session,
      fixture.settings.botSessionLogDir,
      fixture.logger,
    )
    fixture.enqueueAnswer("")
    const result = await registry.submit(123, "question", {
      delivery: { sourceMessageId: 95, statusMessageId: 96, mode: "publish" },
    })
    expect(result.kind).toBe("no_response")
    expect((await session.harness.snapshot(OutboxDoc, context))?.pending).toHaveLength(1)
    expect(result).toMatchObject({ checkpoint: { requestId: expect.any(String) } })
    await registry.dispose()
    const reopened = await fixture.createSession()
    const deliver = vi.fn(async (_answer: { requestId?: string }, _delivery: unknown) => {})
    await reopened.recoverPending(deliver)
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ text: result.text, requestId: expect.any(String) }),
      { sourceMessageId: 95, statusMessageId: 96, mode: "default" },
    )
    expect(fixture.requests).toHaveLength(1)
    expect((await reopened.harness.snapshot(OutboxDoc, context))?.pending).toHaveLength(1)
    const requestId = deliver.mock.calls[0]?.[0].requestId
    if (!requestId) throw new Error("Missing recovered request ID")
    await reopened.acknowledge(requestId)
    expect((await reopened.harness.snapshot(OutboxDoc, context))?.pending).toEqual([])
  })

  it.each(["default", "publish"] as const)(
    "keeps a failed turn pending and recovers its %s delivery without retrying the model",
    async (mode) => {
      const fixture = await setup()
      const session = await fixture.createSession()
      const registry = new ChatSessionRegistry(
        async () => session,
        fixture.settings.botSessionLogDir,
        fixture.logger,
      )
      try {
        fixture.enqueueFailure()
        const result = await registry.submit(123, "failing question", {
          delivery: { sourceMessageId: 105, statusMessageId: 106, mode },
        })
        expect(result.kind).toBe("no_response")
        expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" })
        const pending = (await session.harness.snapshot(OutboxDoc, context))?.pending
        expect(pending).toHaveLength(1)
        const failed = pending?.[0]
        if (!failed) throw new Error("Missing failed-turn delivery intent")
        const terminal = await session.harness.commit(
          (tx) => tx.submissionByRequest(failed.conversationId, failed.requestId),
          context,
        )
        expect(terminal).toMatchObject({ status: "unanswered", reason: "model_error" })
        expect(result).toMatchObject({ checkpoint: { requestId: failed.requestId } })
        await registry.dispose()
        const reopened = await fixture.createSession()
        const deliver = vi.fn(async (_answer: { requestId?: string }, _delivery: unknown) => {})
        await reopened.recoverPending(deliver)
        expect(deliver).toHaveBeenCalledWith(
          expect.objectContaining({
            text: "AI 服務暫時無法使用，請稍後再試。",
            requestId: pending?.[0]?.requestId,
          }),
          { sourceMessageId: 105, statusMessageId: 106, mode: "default" },
        )
        expect(fixture.requests).toHaveLength(1)
        expect(reopened.messages.filter((message) => message.role === "user")).toHaveLength(1)
        expect((await reopened.harness.snapshot(OutboxDoc, context))?.pending).toHaveLength(1)
        const requestId = deliver.mock.calls[0]?.[0].requestId
        if (!requestId) throw new Error("Missing failed-turn request ID")
        await reopened.acknowledge(requestId)
        expect((await reopened.harness.snapshot(OutboxDoc, context))?.pending).toEqual([])
      } finally {
        await registry.dispose()
      }
    },
  )

  it.each(["cancel", "reset"] as const)(
    "withdraws failed-turn delivery through explicit %s",
    async (command) => {
      const fixture = await setup()
      const session = await fixture.createSession()
      const registry = new ChatSessionRegistry(
        async () => session,
        fixture.settings.botSessionLogDir,
        fixture.logger,
      )
      try {
        fixture.enqueueFailure()
        await registry.submit(123, "failing question", {
          delivery: { sourceMessageId: 107, mode: "default" },
        })
        expect(await session.hasPendingResponses()).toBe(true)
        await registry[command](123)
        await registry.dispose()
        const reopened = await fixture.createSession()
        const deliver = vi.fn(async () => {})
        await reopened.recoverPending(deliver)
        expect(deliver).not.toHaveBeenCalled()
        expect(await reopened.hasPendingResponses()).toBe(false)
        expect(fixture.requests).toHaveLength(1)
      } finally {
        await registry.dispose()
      }
    },
  )

  it("does not mix two completed pending deliveries after restart", async () => {
    const fixture = await setup()
    const session = await fixture.createSession()
    fixture.enqueueAnswer("First pending answer")
    await session.prompt("first", { delivery: { sourceMessageId: 91, mode: "default" } })
    fixture.enqueueAnswer("Second pending answer")
    await session.prompt("second", { delivery: { sourceMessageId: 92, mode: "default" } })
    await session.dispose()
    const reopened = await fixture.createSession()
    const texts: string[] = []
    await reopened.recoverPending(async (answer) => {
      texts.push(answer.text)
    })
    expect(texts).toEqual(["First pending answer", "Second pending answer"])
    expect(fixture.requests).toHaveLength(2)
  })

  it("acknowledges delivery even if its derived reply-index write fails", async () => {
    const fixture = await setup()
    const session = await fixture.createSession()
    const registry = new ChatSessionRegistry(
      async () => session,
      fixture.settings.botSessionLogDir,
      fixture.logger,
      { replyTreeEnabled: true },
    )
    const record = vi
      .spyOn(TelegramReplyIndex.prototype, "record")
      .mockRejectedValueOnce(new Error("index unavailable"))
    try {
      fixture.enqueueAnswer("Delivered answer")
      const answer = await registry.submit(123, "question", {
        delivery: { sourceMessageId: 101, mode: "default" },
      })
      if (answer.kind !== "completed") throw new Error("Missing answer")
      await registry.recordDelivery(123, answer.checkpoint, [102])
      expect((await session.harness.snapshot(OutboxDoc, context))?.pending).toEqual([])
    } finally {
      record.mockRestore()
      await registry.dispose()
    }
  })

  it("closes idle historical databases and lazily restores their transcript on new input", async () => {
    const fixture = await setup()
    const ids = new Map<number, string>()
    for (const chatId of [123, 456]) {
      const session = await fixture.createSession(chatId)
      ids.set(chatId, session.sessionId)
      fixture.enqueueAnswer(`Historical answer ${chatId}`)
      await session.prompt(`Historical question ${chatId}`)
      await session.dispose()
    }
    const closed: ReturnType<typeof vi.spyOn>[] = []
    const create = vi.fn(async (chatId: number) => {
      const session = await fixture.createSession(chatId)
      closed.push(vi.spyOn(session, "dispose"))
      expect(session.sessionId).toBe(ids.get(chatId))
      return session
    })
    const registry = new ChatSessionRegistry(
      create,
      fixture.settings.botSessionLogDir,
      fixture.logger,
    )
    try {
      const deliver = vi.fn(async () => true)
      await registry.recover(await fixture.factory.listChats(), deliver)
      expect(create).toHaveBeenCalledTimes(2)
      for (const dispose of closed) expect(dispose).toHaveBeenCalledOnce()
      expect(deliver).not.toHaveBeenCalled()
      fixture.enqueueAnswer("New answer")
      await registry.submit(123, "New question")
      expect(create).toHaveBeenCalledTimes(3)
      expect(JSON.stringify(fixture.requests.at(-1)?.messages)).toContain("Historical answer 123")
      expect(JSON.stringify(fixture.requests.at(-1)?.messages)).not.toContain(
        "Historical answer 456",
      )
    } finally {
      await registry.dispose()
    }
  })

  it("the registry recovers completed responses in the background and acknowledges successful delivery", async () => {
    const fixture = await setup()
    const session = await fixture.createSession()
    fixture.enqueueAnswer("Recovery result")
    await session.prompt("question", { delivery: { sourceMessageId: 61, mode: "default" } })
    await session.dispose()
    const registry = new ChatSessionRegistry(
      asSessionCreator(fixture.factory),
      fixture.settings.botSessionLogDir,
      fixture.logger,
      { replyTreeEnabled: true },
    )
    const deliver = vi.fn(async (_chatId, answer, _saved, checkpoint) => {
      await registry.recordDelivery(123, checkpoint, [62])
      expect(answer.text).toBe("Recovery result")
      return true
    })
    try {
      await registry.recover(await fixture.factory.listChats(), deliver)
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce())
    } finally {
      await registry.dispose()
    }
    const reopened = await fixture.createSession()
    expect((await reopened.harness.snapshot(OutboxDoc, context))?.pending).toEqual([])
  })
})
