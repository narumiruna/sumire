import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import { describe, expect, it, vi } from "vitest"
import type { DurableSession } from "../src/agent/durable/session.js"
import { OutboxDoc } from "../src/agent/durable/state.js"
import {
  ChatSessionRegistry,
  type SubmissionOptions,
  type SubmissionResult,
} from "../src/agent/session-registry.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

describe("cold owner admission", () => {
  it.each(["main", "article"] as const)(
    "resumes four retained children before admitting fresh %s work",
    async (routing) => {
      const pi = await createPiFixture()
      let currentOwner: DurableSession | undefined
      const open = () =>
        new ChatSessionRegistry(
          async (chatId) => {
            currentOwner = await pi.createSession(chatId)
            return currentOwner
          },
          pi.settings.botSessionLogDir,
          pi.logger,
          { control: pi.factory.control, replyTreeEnabled: true },
        )
      const owner = () => {
        if (!currentOwner) throw new Error("Missing cold owner")
        return currentOwner
      }
      let registry = open()
      const work: Promise<SubmissionResult>[] = []
      const oldGates: Array<() => void> = []
      const gates: Array<() => void> = []
      let closing = false
      let restoreFetch = () => {}
      const submit = (text: string, options: SubmissionOptions) => {
        const result = registry.submit(-100, text, options)
        void result.catch(() => {})
        work.push(result)
        return result
      }
      try {
        for (let i = 0; i < 4; i++) {
          oldGates.push(pi.pauseNextRequest())
          submit(`Retained native article ${i}`, {
            routing: "article",
            delivery: { sourceMessageId: 10 + i, statusMessageId: 1010 + i, mode: "publish" },
          })
          await vi.waitFor(() => expect(pi.requests).toHaveLength(i + 1))
        }
        await registry.dispose()
        await Promise.allSettled(work)
        await vi.waitFor(() => expect(pi.disconnectedRequests).toBe(4))
        for (const release of oldGates) release()
        registry = open()

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
          pi.enqueueAnswer(`Offline owned answer ${index}`)
          // Consume the fixture answer before blocking, including during cleanup.
          const response = await originalFetch(input, init)
          if (!closing && index <= 4) await gate
          return response
        })
        restoreFetch = () => provider.mockRestore()

        // This metadata lookup opens the owner, but must not start scheduling.
        expect(await registry.isPendingStatus(-100, 1010)).toBe(true)
        expect(owner().isMainStreaming).toBe(false)
        expect(owner().isStreaming).toBe(true)
        const retained = (await owner().harness.snapshot(OutboxDoc, context))?.pending ?? []
        expect(retained).toHaveLength(4)
        expect(pi.requests).toHaveLength(4)
        expect(gates).toHaveLength(0)

        const accepted = vi.fn()
        const foreground = submit(`Fresh foreground ${routing}`, {
          routing,
          delivery: { sourceMessageId: 60, statusMessageId: 1060, mode: "default" },
          onAccepted: accepted,
        })
        // Foreground admission must wake the retained runs before waiting for a slot.
        await vi.waitFor(() => expect(gates).toHaveLength(4), { timeout: 2_000 })
        await vi.waitFor(() => expect(pi.requests).toHaveLength(8))
        expect(accepted).not.toHaveBeenCalled()
        for (const request of pi.requests.slice(4)) {
          expect(JSON.stringify(request.messages)).toContain("Retained native article")
          expect(JSON.stringify(request.messages)).not.toContain("Fresh foreground")
        }

        gates[0]?.()
        await expect(foreground).resolves.toMatchObject({ text: "Offline owned answer 5" })
        expect(accepted).toHaveBeenCalledOnce()
        expect(gates).toHaveLength(5)
        expect(pi.requests).toHaveLength(9)
        expect(JSON.stringify(pi.requests[8]?.messages)).toContain(`Fresh foreground ${routing}`)
        const unfinished = await owner().harness.commit(async (tx) => {
          const native = await Promise.all(
            retained.map((item) => tx.submissionByRequest(item.conversationId, item.requestId)),
          )
          return native.filter((item) => item?.type === "input" && item.status !== "done")
        }, context)
        expect(unfinished).toHaveLength(3)
        expect(pi.pendingReplies).toBe(0)
      } finally {
        closing = true
        for (const release of gates) release()
        try {
          await registry.dispose()
        } finally {
          restoreFetch()
          for (const release of oldGates) release()
          await Promise.allSettled(work)
          await pi.cleanup()
        }
      }
    },
    15_000,
  )
})
