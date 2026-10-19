import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import type { EntryId, EntryRecord, Harness, UserInput } from "@earendil-works/pi-durable"
import { assistantText, checkpointId } from "./entries.js"
import { OutboxDoc, type PendingResponse, type ResponseDelivery } from "./state.js"

export type DurableAnswer = { text: string; entryId?: string; requestId?: string }
export const NO_RESPONSE_TEXT = "模型沒有回覆內容，請稍後再試。"

/** Persist delivery intent and recover answers. The transport acknowledges successful delivery. */
export class DurableOutbox {
  constructor(private readonly harness: Harness) {}

  async record(pending: PendingResponse): Promise<void> {
    await this.harness.commit(async (tx) => {
      ;(await tx.doc(OutboxDoc)).pending.push(pending)
    }, context)
  }

  async clear(): Promise<void> {
    await this.harness.commit(async (tx) => {
      ;(await tx.doc(OutboxDoc)).pending = []
    }, context)
  }

  async acknowledge(requestId: string): Promise<void> {
    await this.harness.commit(async (tx) => {
      const outbox = await tx.doc(OutboxDoc)
      outbox.pending = outbox.pending.filter((pending) => pending.requestId !== requestId)
    }, context)
  }

  async hasPendingResponses(): Promise<boolean> {
    return Boolean((await this.harness.snapshot(OutboxDoc, context))?.pending.length)
  }

  async recoverPending(
    deliver: (answer: DurableAnswer, delivery: ResponseDelivery) => Promise<void>,
    isClosing: () => boolean,
  ): Promise<void> {
    if (isClosing()) return
    this.harness.resume()
    const outbox = await this.harness.snapshot(OutboxDoc, context)
    for (const pending of outbox?.pending ?? []) {
      const conversation = await this.harness.conversation(pending.conversationId, context)
      if (!conversation) throw new Error("Durable outbox conversation is missing")
      let entry: EntryRecord | undefined
      if (pending.answerEntryId !== undefined) {
        entry = await this.harness.commit(
          (tx) => tx.entry(pending.answerEntryId as EntryId),
          context,
        )
      } else {
        const submission = await conversation.submit(
          { type: "input", requestId: pending.requestId, content: pending.content as UserInput },
          context,
        )
        const settled = await submission.wait(context)
        if (isClosing()) return
        await conversation.waitForIdle(context)
        if (settled.status === "done" && settled.type === "input") {
          const view = await conversation.context(context)
          entry = view.entries.findLast((candidate) =>
            candidate.model?.some((message) => message.role === "assistant"),
          )
          if (entry) await this.captureAnswer(pending.requestId, entry.id)
        }
      }
      if (isClosing()) return
      const current = await this.harness.snapshot(OutboxDoc, context)
      if (!current?.pending.some((item) => item.requestId === pending.requestId)) continue

      const text = assistantText(entry)
      await deliver(
        {
          text: text || (entry ? NO_RESPONSE_TEXT : "AI 服務暫時無法使用，請稍後再試。"),
          requestId: pending.requestId,
          ...(entry ? { entryId: checkpointId(entry) } : {}),
        },
        text ? pending.delivery : { ...pending.delivery, mode: "default" },
      )
    }
  }

  async captureAnswer(requestId: string, entryId: EntryId): Promise<void> {
    await this.harness.commit(async (tx) => {
      const pending = (await tx.doc(OutboxDoc)).pending.find((item) => item.requestId === requestId)
      if (pending) pending.answerEntryId = entryId
    }, context)
  }
}
