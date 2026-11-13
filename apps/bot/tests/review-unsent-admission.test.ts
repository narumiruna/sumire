import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import { describe, expect, it, vi } from "vitest"
import type { DurableSession } from "../src/agent/durable/session.js"
import {
  ConversationPurposeDoc,
  OutboxDoc,
  type PendingResponse,
} from "../src/agent/durable/state.js"
import { ChatSessionRegistry, type SubmissionResult } from "../src/agent/session-registry.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Offline test cleanup timed out")), 5_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe("cold unsent outbox admission", () => {
  it.each([
    { routing: "main", startupFailure: false, action: "complete" },
    { routing: "article", startupFailure: false, action: "complete" },
    { routing: "main", startupFailure: true, action: "complete" },
    { routing: "article", startupFailure: false, action: "overlap recovery" },
    { routing: "main", startupFailure: false, action: "cancel" },
    { routing: "main", startupFailure: false, action: "main failure" },
  ] as const)(
    "starts older intents before fresh $routing work (startup failure: $startupFailure, $action)",
    async ({ routing, startupFailure, action }) => {
      const pi = await createPiFixture()
      let currentOwner: DurableSession | undefined
      let registry: ChatSessionRegistry | undefined
      let foreground: Promise<SubmissionResult> | undefined
      const gates: Array<() => void> = []
      let closing = false
      let restoreFetch = () => {}
      const owner = () => {
        if (!currentOwner) throw new Error("Missing reopened owner")
        return currentOwner
      }
      try {
        const original = await pi.createSession(-100)
        const pending: PendingResponse[] = []
        for (let i = 0; i < 4; i++) {
          const retainedMain = action === "main failure" && i === 0
          const conversation = retainedMain
            ? await original.harness.root(context)
            : await original.harness.createConversation(
                {
                  ownership: { kind: "ownerless" },
                  agent: {
                    model: { provider: original.model.provider, modelId: original.model.id },
                    thinkingLevel: original.thinkingLevel,
                    cwd: original.cwd,
                  },
                },
                context,
              )
          if (!retainedMain)
            await conversation.commit(async (tx) => {
              ;(await tx.doc(ConversationPurposeDoc, conversation.id)).purpose = "article"
            }, context)
          pending.push({
            requestId: `unsent-article-${i}`,
            conversationId: conversation.id,
            content: `Older unsent article ${i}`,
            delivery: { sourceMessageId: 10 + i, statusMessageId: 1010 + i, mode: "publish" },
          })
        }
        // Authorized synthetic crash window: intent persisted, native submit not yet called.
        await original.harness.commit(async (tx) => {
          ;(await tx.doc(OutboxDoc)).pending.push(...pending)
        }, context)
        await original.dispose()

        const create = vi.fn(async (chatId: number) => {
          if (startupFailure && create.mock.calls.length === 1)
            throw new Error("Offline startup open failure")
          currentOwner = await pi.createSession(chatId)
          return currentOwner
        })
        registry = new ChatSessionRegistry(create, pi.settings.botSessionLogDir, pi.logger, {
          control: pi.factory.control,
          replyTreeEnabled: true,
        })
        const deliver = vi.fn<Parameters<ChatSessionRegistry["recover"]>[1]>(async () => false)
        if (startupFailure) {
          await registry.recover([-100], deliver)
          expect(create).toHaveBeenCalledOnce()
          expect(currentOwner).toBeUndefined()
        }

        const originalFetch = globalThis.fetch
        const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
          const url = input instanceof Request ? input.url : String(input)
          if (!url.startsWith(pi.endpoint)) return originalFetch(input, init)
          let release = () => {}
          const gate = new Promise<void>((resolve) => {
            release = resolve
          })
          gates.push(release)
          const index = gates.length
          if (action === "main failure" && index === 1) pi.enqueueFailure()
          else pi.enqueueAnswer(`Offline unsent answer ${index}`)
          // Consume every local answer before blocking, including during cleanup.
          const response = await originalFetch(input, init)
          if (!closing && index <= 4) await gate
          return response
        })
        restoreFetch = () => provider.mockRestore()

        // Metadata-only reopen must preserve all four unsent intents without scheduling.
        expect(await registry.isPendingStatus(-100, 1010)).toBe(true)
        expect(create).toHaveBeenCalledTimes(startupFailure ? 2 : 1)
        expect(owner().isStreaming).toBe(false)
        expect((await owner().harness.snapshot(OutboxDoc, context))?.pending).toEqual(pending)
        expect(new Set(pending.map((item) => item.conversationId)).size).toBe(4)
        for (const item of pending) {
          expect(item.answerEntryId).toBeUndefined()
          expect(
            await owner().harness.commit(
              (tx) => tx.submissionByRequest(item.conversationId, item.requestId),
              context,
            ),
          ).toBeUndefined()
        }
        expect(pi.requests).toHaveLength(0)
        expect(gates).toHaveLength(0)

        const accepted = vi.fn()
        foreground = registry.submit(-100, `Fresh foreground ${routing}`, {
          routing,
          delivery: { sourceMessageId: 60, statusMessageId: 1060, mode: "default" },
          onAccepted: accepted,
        })
        void foreground.catch(() => {})
        // No explicit recover or Harness.resume: foreground must start the older inputs.
        await vi.waitFor(() => expect(gates).toHaveLength(4), { timeout: 2_000 })
        await vi.waitFor(() => expect(pi.requests).toHaveLength(4))
        expect(accepted).not.toHaveBeenCalled()
        for (const item of pending) {
          expect(
            pi.requests.filter((request) =>
              JSON.stringify(request.messages).includes(String(item.content)),
            ),
          ).toHaveLength(1)
          expect(
            await owner().harness.commit(
              (tx) => tx.submissionByRequest(item.conversationId, item.requestId),
              context,
            ),
          ).toMatchObject({ type: "input", requestId: item.requestId })
        }
        expect(
          pi.requests.every(
            (request) => !JSON.stringify(request.messages).includes("Fresh foreground"),
          ),
        ).toBe(true)

        if (action === "main failure") {
          expect(JSON.stringify(pi.requests[0]?.messages)).toContain(String(pending[0]?.content))
          gates[1]?.()
          await vi.waitFor(async () => {
            const item = pending[1]
            if (!item) throw new Error("Missing retained peer")
            expect(
              await owner().harness.commit(
                (tx) => tx.submissionByRequest(item.conversationId, item.requestId),
                context,
              ),
            ).toMatchObject({ status: "done" })
          })
          expect(accepted).not.toHaveBeenCalled()
          await expect(
            bounded(
              registry.submit(-100, "Independent article while saved main waits", {
                routing: "article",
                delivery: { sourceMessageId: 80, statusMessageId: 1080, mode: "publish" },
              }),
            ),
          ).resolves.toMatchObject({ text: "Offline unsent answer 5" })
          expect(accepted).not.toHaveBeenCalled()
          gates[0]?.()
          await expect(bounded(foreground)).resolves.toMatchObject({
            text: "Offline unsent answer 6",
          })
          await expect(
            bounded(
              registry.submit(-100, "Later main after unsent failure", {
                routing: "main",
                delivery: { sourceMessageId: 70, statusMessageId: 1070, mode: "default" },
              }),
            ),
          ).resolves.toMatchObject({ text: "Offline unsent answer 7" })
          expect(pi.requests).toHaveLength(7)
          expect(accepted).toHaveBeenCalledOnce()
          return
        }

        if (action === "cancel") {
          const cancellation = registry.cancel(-100)
          await vi.waitFor(async () => {
            expect((await owner().harness.snapshot(OutboxDoc, context))?.pending).toEqual([])
          })
          for (const release of gates) release()
          await expect(bounded(cancellation)).resolves.toBe(true)
          await bounded(Promise.allSettled([foreground]))
          expect(accepted).not.toHaveBeenCalled()
          expect(pi.requests).toHaveLength(4)
          expect(pi.pendingReplies).toBe(0)
          expect(deliver).not.toHaveBeenCalled()
          return
        }
        if (action === "overlap recovery") await registry.recover([-100], deliver)

        gates[0]?.()
        await expect(bounded(foreground)).resolves.toMatchObject({
          text: "Offline unsent answer 5",
        })
        expect(accepted).toHaveBeenCalledOnce()
        expect(gates).toHaveLength(5)
        expect(pi.requests).toHaveLength(5)
        const native = await owner().harness.commit(
          (tx) =>
            Promise.all(
              pending.map((item) => tx.submissionByRequest(item.conversationId, item.requestId)),
            ),
          context,
        )
        expect(native.filter((item) => item?.status === "done")).toHaveLength(1)
        expect(native.filter((item) => item?.status !== "done")).toHaveLength(3)
        for (const item of pending) {
          expect((await owner().harness.snapshot(OutboxDoc, context))?.pending).toContainEqual(
            expect.objectContaining(item),
          )
        }
        if (action !== "overlap recovery") expect(deliver).not.toHaveBeenCalled()

        for (const release of gates) release()
        await vi.waitFor(async () => {
          const settled = await owner().harness.commit(
            (tx) =>
              Promise.all(
                pending.map((item) => tx.submissionByRequest(item.conversationId, item.requestId)),
              ),
            context,
          )
          expect(settled.every((item) => item?.status === "done")).toBe(true)
        })
        for (const item of pending) {
          const conversation = await owner().harness.conversation(item.conversationId, context)
          if (!conversation) throw new Error("Missing retained article conversation")
          const entries = await conversation.entries({}, 100, undefined, context)
          const users = entries.items
            .flatMap((entry) => entry.model ?? [])
            .filter((message) => message.role === "user")
          expect(users).toHaveLength(1)
        }
        if (action === "overlap recovery") {
          await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(4))
          for (const item of pending) {
            const calls = deliver.mock.calls.filter(
              ([, answer]) => answer.requestId === item.requestId,
            )
            expect(calls).toHaveLength(1)
            expect(calls[0]?.[0]).toBe(-100)
            expect(calls[0]?.[2]).toEqual(item.delivery)
            expect(calls[0]?.[3]).toMatchObject({ requestId: item.requestId })
            expect(calls[0]?.[4]()).toBe(true)
          }
        }
        expect(pi.requests).toHaveLength(5)
        expect(pi.pendingReplies).toBe(0)
      } finally {
        closing = true
        for (const release of gates) release()
        try {
          await bounded(
            (async () => {
              await registry?.dispose()
              if (foreground) await Promise.allSettled([foreground])
              await pi.cleanup()
            })(),
          )
        } finally {
          restoreFetch()
        }
      }
    },
    20_000,
  )
})
