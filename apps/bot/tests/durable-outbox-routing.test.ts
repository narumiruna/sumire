import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai/models"
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import {
  type Conversation,
  createRegistry,
  type EntryId,
  Harness,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { afterEach, describe, expect, it, vi } from "vitest"
import { checkpointId } from "../src/agent/durable/entries.js"
import type { GeneratedMedia } from "../src/agent/durable/media.js"
import {
  type DurableAnswer,
  DurableOutbox,
  MAX_CONCURRENT_DELIVERIES,
  NO_RESPONSE_TEXT,
} from "../src/agent/durable/outbox.js"
import { OutboxDoc, type ResponseDelivery } from "../src/agent/durable/state.js"

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "sumire-outbox-routing-"))
  const file = path.join(directory, "session.sqlite")
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const harnesses = new Set<Harness>()
  cleanups.push(async () => {
    for (const harness of harnesses) await harness.close(context)
    await rm(directory, { recursive: true, force: true })
  })
  const open = async () => {
    const harness = await Harness.open(
      await openNodeSqliteStorage(file),
      { models, registry: createRegistry(), settings: { retry: { maxRetries: 0 } } },
      context,
    )
    harnesses.add(harness)
    return harness
  }
  const close = async (harness: Harness) => {
    await harness.close(context)
    harnesses.delete(harness)
  }
  const conversation = (harness: Harness) =>
    harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: faux.getModel().provider, modelId: faux.getModel().id } },
      },
      context,
    )
  const submit = async (
    harness: Harness,
    target: Conversation,
    requestId: string,
    options: { cached?: EntryId; media?: GeneratedMedia[]; mode?: ResponseDelivery["mode"] } = {},
  ) => {
    const outbox = new DurableOutbox(harness)
    await outbox.record({
      requestId,
      conversationId: target.id,
      content: requestId,
      delivery: { sourceMessageId: requestId.length, mode: options.mode ?? "publish" },
      ...(options.cached === undefined ? {} : { answerEntryId: options.cached }),
      ...(options.media ? { media: options.media, textMessageIds: [91] } : {}),
    })
    return target.submit({ type: "input", requestId, content: requestId }, context)
  }
  return { open, close, conversation, submit, faux }
}

async function answerEntry(harness: Harness, conversation: Conversation, requestId: string) {
  const settled = await harness.commit(
    (tx) => tx.submissionByRequest(conversation.id, requestId),
    context,
  )
  if (settled?.type !== "input" || settled.status !== "done")
    throw new Error("Missing native answer")
  const entry = await harness.commit((tx) => tx.entry(settled.answer), context)
  if (!entry) throw new Error("Missing answer entry")
  return entry
}

async function inputCheckpoint(harness: Harness, conversation: Conversation, requestId: string) {
  const record = await harness.commit(
    (tx) => tx.submissionByRequest(conversation.id, requestId),
    context,
  )
  if (record?.type !== "input" || record.entry === undefined)
    throw new Error("Missing native input")
  return `${conversation.id}:${record.entry}`
}

const media: GeneratedMedia = {
  id: "00000000-0000-4000-8000-000000000001",
  extension: "png",
  mimeType: "image/png",
  width: 1,
  height: 1,
  byteLength: 1,
  sha256: "fixture",
  taskId: 1,
  callId: "owned-image",
  messageId: 92,
}

describe("durable outbox submission routing", () => {
  it.each(["uncaptured", "same-conversation", "other-conversation", "missing"] as const)(
    "recovers the native answer and repairs a %s cache without another model request",
    async (cache) => {
      const f = await fixture()
      let harness = await f.open()
      const target = await f.conversation(harness)
      f.faux.setResponses([
        fauxAssistantMessage("Owned answer"),
        fauxAssistantMessage("Unrelated later answer"),
        fauxAssistantMessage("Other conversation answer"),
      ])
      await (await f.submit(harness, target, "owned")).wait(context)
      const owned = await answerEntry(harness, target, "owned")
      await (
        await target.submit({ type: "input", content: "later", requestId: "later" }, context)
      ).wait(context)
      const later = await answerEntry(harness, target, "later")
      const other = await f.conversation(harness)
      await (
        await other.submit({ type: "input", content: "other", requestId: "other" }, context)
      ).wait(context)
      const peer = await answerEntry(harness, other, "other")
      if (cache !== "uncaptured")
        await new DurableOutbox(harness).captureAnswer(
          "owned",
          cache === "same-conversation"
            ? later.id
            : cache === "other-conversation"
              ? peer.id
              : (999999 as EntryId),
        )
      await f.close(harness)
      harness = await f.open()
      const deliver = vi.fn(async (_answer: DurableAnswer, _delivery: ResponseDelivery) => {})
      await new DurableOutbox(harness).recoverPending(deliver, () => false)
      expect(deliver).toHaveBeenCalledExactlyOnceWith(
        {
          text: "Owned answer",
          requestId: "owned",
          entryId: checkpointId(owned),
          inputEntryId: await inputCheckpoint(harness, target, "owned"),
        },
        { sourceMessageId: 5, mode: "publish" },
      )
      expect((await harness.snapshot(OutboxDoc, context))?.pending[0]?.answerEntryId).toBe(owned.id)
      expect(f.faux.state.callCount).toBe(3)
    },
  )

  it.each([false, true])(
    "keeps failure and partial media semantics without unrelated text (media=%s)",
    async (withMedia) => {
      const f = await fixture()
      let harness = await f.open()
      const target = await f.conversation(harness)
      f.faux.setResponses([
        fauxAssistantMessage("Unrelated previous answer"),
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "Offline failure" }),
        fauxAssistantMessage("Unrelated subsequent answer"),
      ])
      await (
        await target.submit({ type: "input", content: "previous", requestId: "previous" }, context)
      ).wait(context)
      const previous = await answerEntry(harness, target, "previous")
      const failed = await f.submit(harness, target, "failed", {
        cached: previous.id,
        ...(withMedia ? { media: [media] } : {}),
      })
      expect((await failed.wait(context)).status).toBe("unanswered")
      await (
        await target.submit(
          { type: "input", content: "subsequent", requestId: "subsequent" },
          context,
        )
      ).wait(context)
      await f.close(harness)
      harness = await f.open()
      const outbox = new DurableOutbox(harness)
      const deliver = vi.fn(async (_answer: DurableAnswer, _delivery: ResponseDelivery) => {})
      await outbox.recoverPending(deliver, () => false)
      expect(deliver).toHaveBeenCalledExactlyOnceWith(
        {
          text: withMedia ? "" : "AI 服務暫時無法使用，請稍後再試。",
          requestId: "failed",
          inputEntryId: await inputCheckpoint(harness, target, "failed"),
          ...(withMedia ? { media: [media], textMessageIds: [91] } : {}),
        },
        { sourceMessageId: 6, mode: "default" },
      )
      expect(
        (await harness.snapshot(OutboxDoc, context))?.pending[0]?.answerEntryId,
      ).toBeUndefined()
      if (withMedia) {
        await outbox.acknowledge("failed")
        expect((await harness.snapshot(OutboxDoc, context))?.mediaReceipts).toEqual([
          { requestId: "failed", id: media.id, messageId: 92 },
        ])
      }
      expect(f.faux.state.callCount).toBe(3)
    },
  )

  it("does not replay a cached response whose native submission is missing", async () => {
    const f = await fixture()
    const harness = await f.open()
    const target = await f.conversation(harness)
    f.faux.setResponses([fauxAssistantMessage("Unrelated answer")])
    await (
      await target.submit({ type: "input", content: "unrelated", requestId: "unrelated" }, context)
    ).wait(context)
    const unrelated = await answerEntry(harness, target, "unrelated")
    const outbox = new DurableOutbox(harness)
    await outbox.record({
      requestId: "missing-native",
      conversationId: target.id,
      content: "must not replay",
      delivery: { sourceMessageId: 1, mode: "publish" },
      answerEntryId: unrelated.id,
    })
    const deliver = vi.fn(async (_answer: DurableAnswer, _delivery: ResponseDelivery) => {})
    await outbox.recoverPending(deliver, () => false)
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      { text: "AI 服務暫時無法使用，請稍後再試。", requestId: "missing-native" },
      { sourceMessageId: 1, mode: "default" },
    )
    expect(f.faux.state.callCount).toBe(1)
    expect(
      await harness.commit((tx) => tx.submissionByRequest(target.id, "missing-native"), context),
    ).toBeUndefined()
    expect((await harness.snapshot(OutboxDoc, context))?.pending[0]?.answerEntryId).toBe(
      unrelated.id,
    )
    await outbox.recoverPending(deliver, () => false)
    expect(f.faux.state.callCount).toBe(1)
    expect(deliver).toHaveBeenCalledTimes(2)
  })

  it("delivers a settled native answer without waiting for a later run in the same conversation", async () => {
    const f = await fixture()
    const harness = await f.open()
    const target = await f.conversation(harness)
    const release = deferred()
    cleanups.push(async () => release.resolve())
    f.faux.setResponses([
      fauxAssistantMessage("Owned answer"),
      async () => {
        await release.promise
        return fauxAssistantMessage("Later answer")
      },
    ])
    await (await f.submit(harness, target, "owned")).wait(context)
    const owned = await answerEntry(harness, target, "owned")
    const later = await target.submit(
      { type: "input", content: "later", requestId: "later" },
      context,
    )
    await vi.waitFor(() => expect(f.faux.state.callCount).toBe(2))
    const deliver = vi.fn(async (_answer: DurableAnswer, _delivery: ResponseDelivery) => {})
    const recovery = new DurableOutbox(harness).recoverPending(deliver, () => false)
    try {
      await vi.waitFor(async () =>
        expect(deliver).toHaveBeenCalledExactlyOnceWith(
          {
            text: "Owned answer",
            requestId: "owned",
            entryId: checkpointId(owned),
            inputEntryId: await inputCheckpoint(harness, target, "owned"),
          },
          { sourceMessageId: 5, mode: "publish" },
        ),
      )
      expect((await later.status(context)).status).toBe("placed")
      await recovery
    } finally {
      release.resolve()
      await later.wait(context)
      await recovery
    }
  })

  it("recovers an empty native answer as no-response with its own checkpoint", async () => {
    const f = await fixture()
    const harness = await f.open()
    const target = await f.conversation(harness)
    f.faux.setResponses([fauxAssistantMessage("")])
    await (await f.submit(harness, target, "empty")).wait(context)
    const entry = await answerEntry(harness, target, "empty")
    const deliver = vi.fn(async (_answer: DurableAnswer, _delivery: ResponseDelivery) => {})
    await new DurableOutbox(harness).recoverPending(deliver, () => false)
    expect(deliver).toHaveBeenCalledExactlyOnceWith(
      {
        text: NO_RESPONSE_TEXT,
        requestId: "empty",
        entryId: checkpointId(entry),
        inputEntryId: await inputCheckpoint(harness, target, "empty"),
      },
      { sourceMessageId: 5, mode: "default" },
    )
    expect(f.faux.state.callCount).toBe(1)
  })

  it("delivers ready B/C after restart while more than a delivery pool of earlier A requests remain blocked", async () => {
    const f = await fixture()
    let harness = await f.open()
    const release = deferred()
    cleanups.push(async () => release.resolve())
    let blockedCalls = 0
    f.faux.setResponses(
      Array.from({ length: 100 }, () => async (transcript, options) => {
        const input = transcript.messages.findLast((message) => message.role === "user")
        const name =
          input?.role === "user" && typeof input.content === "string" ? input.content : "unknown"
        if (name.startsWith("blocked")) {
          blockedCalls++
          await Promise.race([
            release.promise,
            new Promise<void>((resolve) => {
              if (options?.signal?.aborted) resolve()
              else options?.signal?.addEventListener("abort", () => resolve(), { once: true })
            }),
          ])
        }
        return fauxAssistantMessage(`Answer ${name}`)
      }),
    )
    const targets: Conversation[] = []
    for (let index = 0; index < MAX_CONCURRENT_DELIVERIES * 2 + 1; index++) {
      const target = await f.conversation(harness)
      targets.push(target)
      await f.submit(harness, target, `blocked-${index}`)
    }
    for (const name of ["B", "C"]) {
      const target = await f.conversation(harness)
      await (await f.submit(harness, target, name)).wait(context)
    }
    await vi.waitFor(() => expect(blockedCalls).toBe(targets.length))
    await f.close(harness)
    harness = await f.open()
    const outbox = new DurableOutbox(harness)
    const delivered: string[] = []
    let finished = false
    const recovery = outbox
      .recoverPending(
        async (answer) => {
          delivered.push(answer.requestId ?? "missing")
          await outbox.acknowledge(answer.requestId ?? "missing")
        },
        () => false,
      )
      .finally(() => {
        finished = true
      })
    try {
      await vi.waitFor(() => expect(delivered).toEqual(["B", "C"]))
      expect(finished).toBe(false)
      expect((await harness.snapshot(OutboxDoc, context))?.pending).toHaveLength(targets.length)
      expect((await harness.inspect(context)).submissions).toHaveLength(targets.length)
      release.resolve()
      await recovery
      expect(delivered).toHaveLength(targets.length + 2)
      expect(await outbox.hasPendingResponses()).toBe(false)
    } finally {
      release.resolve()
      await recovery
    }
  })

  it("bounds concurrent delivery, drains peers after errors, and skips canceled queued deliveries", async () => {
    const f = await fixture()
    const harness = await f.open()
    const outbox = new DurableOutbox(harness)
    const release = deferred()
    const started: string[] = []
    let active = 0
    let maximum = 0
    const count = MAX_CONCURRENT_DELIVERIES + 3
    f.faux.setResponses(Array.from({ length: count }, () => fauxAssistantMessage("Ready")))
    for (let index = 0; index < count; index++) {
      const target = await f.conversation(harness)
      await (await f.submit(harness, target, `ready-${index}`)).wait(context)
    }
    let finished = false
    const recovery = outbox
      .recoverPending(
        async (answer) => {
          const id = answer.requestId ?? "missing"
          started.push(id)
          active++
          maximum = Math.max(maximum, active)
          try {
            if (id === "ready-0") throw new Error("Delivery failed")
            await release.promise
          } finally {
            active--
          }
        },
        () => false,
      )
      .then(
        () => {
          finished = true
          return undefined
        },
        (error: unknown) => {
          finished = true
          return error
        },
      )
    try {
      await vi.waitFor(() => expect(active).toBe(MAX_CONCURRENT_DELIVERIES))
      expect(finished).toBe(false)
      expect(started).toHaveLength(MAX_CONCURRENT_DELIVERIES + 1)
      await outbox.clear()
      release.resolve()
      const error = await recovery
      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([
        expect.objectContaining({ message: "Delivery failed" }),
      ])
      expect(maximum).toBe(MAX_CONCURRENT_DELIVERIES)
      expect(active).toBe(0)
      expect(started).toHaveLength(MAX_CONCURRENT_DELIVERIES + 1)
    } finally {
      release.resolve()
      await recovery
    }
  })

  it("admits a pre-submit crash intent once and preserves running work across recovery shutdown", async () => {
    const f = await fixture()
    let harness = await f.open()
    const target = await f.conversation(harness)
    await new DurableOutbox(harness).record({
      requestId: "accepted",
      conversationId: target.id,
      content: "accepted",
      delivery: { sourceMessageId: 4, mode: "default" },
    })
    await f.close(harness)
    harness = await f.open()
    const release = deferred()
    cleanups.push(async () => release.resolve())
    f.faux.setResponses([
      async (_transcript, options) => {
        await Promise.race([
          release.promise,
          new Promise<void>((resolve) => {
            if (options?.signal?.aborted) resolve()
            else options?.signal?.addEventListener("abort", () => resolve(), { once: true })
          }),
        ])
        return fauxAssistantMessage("Interrupted attempt")
      },
      fauxAssistantMessage("Recovered accepted answer"),
    ])
    let closing = false
    const deliver = vi.fn(async (_answer: DurableAnswer, _delivery: ResponseDelivery) => {})
    const recovery = new DurableOutbox(harness).recoverPending(deliver, () => closing)
    await vi.waitFor(() => expect(f.faux.state.callCount).toBe(1))
    const admitted = await harness.commit(
      (tx) => tx.submissionByRequest(target.id, "accepted"),
      context,
    )
    expect(admitted?.status).toBe("placed")
    closing = true
    await f.close(harness)
    await recovery
    expect(deliver).not.toHaveBeenCalled()
    harness = await f.open()
    const outbox = new DurableOutbox(harness)
    await outbox.recoverPending(deliver, () => false)
    expect(deliver).toHaveBeenCalledOnce()
    expect(deliver.mock.calls[0]?.[0]).toMatchObject({
      text: "Recovered accepted answer",
      requestId: "accepted",
    })
    expect(
      (await harness.commit((tx) => tx.submissionByRequest(target.id, "accepted"), context))?.id,
    ).toBe(admitted?.id)
    const restored = await harness.conversation(target.id, context)
    expect(
      (await restored?.entries({}, 100, undefined, context))?.items.filter(
        (entry) => entry.kind === "pi.user",
      ),
    ).toHaveLength(1)
    await outbox.recoverPending(deliver, () => false)
    expect(f.faux.state.callCount).toBe(2)
  })

  it("does not admit a canceled recovery intent or deliver an answer that settles after cancellation", async () => {
    const f = await fixture()
    const harness = await f.open()
    const outbox = new DurableOutbox(harness)
    const target = await f.conversation(harness)
    await outbox.record({
      requestId: "not-admitted",
      conversationId: target.id,
      content: "not-admitted",
      delivery: { sourceMessageId: 1, mode: "default" },
    })
    const lookup = harness.conversation.bind(harness)
    vi.spyOn(harness, "conversation").mockImplementationOnce(async (...args) => {
      await outbox.clear()
      return lookup(...args)
    })
    const deliver = vi.fn(async () => {})
    await outbox.recoverPending(deliver, () => false)
    expect(
      await harness.commit((tx) => tx.submissionByRequest(target.id, "not-admitted"), context),
    ).toBeUndefined()
    expect(f.faux.state.callCount).toBe(0)
    const release = deferred()
    cleanups.push(async () => release.resolve())
    f.faux.setResponses([
      async () => {
        await release.promise
        return fauxAssistantMessage("Canceled late answer")
      },
    ])
    const submission = await f.submit(harness, target, "late")
    const recovery = outbox.recoverPending(deliver, () => false)
    await vi.waitFor(() => expect(f.faux.state.callCount).toBe(1))
    await outbox.clear()
    release.resolve()
    await submission.wait(context)
    await recovery
    expect(deliver).not.toHaveBeenCalled()
  })
})
