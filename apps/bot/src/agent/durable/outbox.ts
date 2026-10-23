import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import {
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Harness,
  LiveDoc,
  type UserInput,
} from "@earendil-works/pi-durable"
import { assistantText, checkpointId } from "./entries.js"
import type { GeneratedMedia, GeneratedMediaFiles } from "./media.js"
import { OutboxDoc, type PendingResponse, type ResponseDelivery } from "./state.js"

export type DurableAnswer = {
  text: string
  entryId?: string
  requestId?: string
  media?: GeneratedMedia[]
  textMessageIds?: number[]
}
export const NO_RESPONSE_TEXT = "模型沒有回覆內容，請稍後再試。"

/** Persist response components. Only the transport can acknowledge complete delivery. */
export class DurableOutbox {
  constructor(
    private readonly harness: Harness,
    private readonly files?: GeneratedMediaFiles,
  ) {}

  async record(pending: PendingResponse): Promise<void> {
    await this.harness.commit(async (tx) => {
      ;(await tx.doc(OutboxDoc)).pending.push(pending)
    }, context)
  }
  async relateInput(conversationId: ConversationId, requestId: string): Promise<void> {
    await this.harness.commit(async (tx) => {
      const live = await tx.doc(LiveDoc, conversationId)
      for (const item of (await tx.doc(OutboxDoc)).pending) {
        if (item.conversationId !== conversationId) continue
        for (const id of [item.requestId, ...(item.relatedRequestIds ?? [])]) {
          const input = await tx.submissionByRequest(conversationId, id)
          if (input && live.run?.inputs.includes(input.id)) {
            item.relatedRequestIds = [...(item.relatedRequestIds ?? []), requestId]
            return
          }
        }
      }
    }, context)
  }
  async clear(): Promise<void> {
    const media = await this.harness.commit(async (tx) => {
      const outbox = await tx.doc(OutboxDoc)
      const media = outbox.pending.flatMap((item) => item.media ?? []).map((item) => ({ ...item }))
      outbox.pending = []
      return media
    }, context)
    await Promise.all(media.map((item) => this.files?.remove(item)))
  }
  async acknowledge(requestId: string): Promise<void> {
    const media = await this.harness.commit(async (tx) => {
      const outbox = await tx.doc(OutboxDoc)
      const pending = outbox.pending.find((item) => item.requestId === requestId)
      const media = pending?.media ?? []
      if (media.some((item) => item.messageId === undefined))
        throw new Error("Image delivery is incomplete")
      outbox.mediaReceipts ??= []
      for (const item of media)
        outbox.mediaReceipts.push({ requestId, id: item.id, messageId: item.messageId as number })
      outbox.mediaReceipts = outbox.mediaReceipts.slice(-100)
      outbox.pending = outbox.pending.filter((item) => item.requestId !== requestId)
      return media.map((item) => ({ ...item }))
    }, context)
    await Promise.all(media.map((item) => this.files?.remove(item)))
  }
  async hasPendingResponses(): Promise<boolean> {
    return Boolean((await this.harness.snapshot(OutboxDoc, context))?.pending.length)
  }
  async prepareFiles(): Promise<void> {
    const outbox = await this.harness.snapshot(OutboxDoc, context)
    await this.files?.prune(outbox?.pending.flatMap((item) => item.media ?? []) ?? [])
  }
  async answer(requestId: string, text: string, entry?: EntryRecord): Promise<DurableAnswer> {
    const pending = (await this.harness.snapshot(OutboxDoc, context))?.pending.find(
      (item) => item.requestId === requestId,
    )
    return {
      text,
      requestId,
      ...(entry ? { entryId: checkpointId(entry) } : {}),
      ...(pending?.media?.length
        ? { media: pending.media, textMessageIds: pending.textMessageIds ?? [] }
        : {}),
    }
  }
  async readImage(requestId: string, id: string): Promise<Buffer> {
    const pending = (await this.harness.snapshot(OutboxDoc, context))?.pending.find(
      (item) => item.requestId === requestId,
    )
    const media = pending?.media?.find((item) => item.id === id)
    if (!media || !this.files) throw new Error("Image delivery is unavailable")
    return this.files.read(media)
  }
  async recordComponent(requestId: string, component: string, messageId: number): Promise<void> {
    if (!Number.isSafeInteger(messageId) || messageId <= 0)
      throw new Error("Invalid Telegram message ID")
    await this.harness.commit(async (tx) => {
      const pending = (await tx.doc(OutboxDoc)).pending.find((item) => item.requestId === requestId)
      if (!pending) throw new Error("Image delivery was cancelled")
      if (component === "text") pending.textMessageIds = [messageId]
      else {
        const media = pending.media?.find((item) => item.id === component)
        if (!media) throw new Error("Image delivery is unavailable")
        media.messageId = messageId
      }
    }, context)
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
      if (pending.answerEntryId !== undefined)
        entry = await this.harness.commit(
          (tx) => tx.entry(pending.answerEntryId as EntryId),
          context,
        )
      else {
        const submission = await conversation.submit(
          { type: "input", requestId: pending.requestId, content: pending.content as UserInput },
          context,
        )
        const settled = await submission.wait(context)
        if (isClosing()) return
        await conversation.waitForIdle(context)
        if (settled.status === "done" && settled.type === "input") {
          const view = await conversation.context(context)
          entry = view.entries.findLast((item) =>
            item.model?.some((message) => message.role === "assistant"),
          )
          if (entry) await this.captureAnswer(pending.requestId, entry.id)
        } else if (
          (await this.harness.snapshot(OutboxDoc, context))?.pending.find(
            (item) => item.requestId === pending.requestId,
          )?.media?.length
        ) {
          // A successful image remains deliverable even if the following model request failed.
          const view = await conversation.context(context)
          entry = view.entries.findLast((item) =>
            item.model?.some((message) => message.role === "assistant"),
          )
          if (entry) await this.captureAnswer(pending.requestId, entry.id)
        }
      }
      if (isClosing()) return
      const current = await this.harness.snapshot(OutboxDoc, context)
      if (!current?.pending.some((item) => item.requestId === pending.requestId)) continue
      const text = assistantText(entry)
      const answer = await this.answer(pending.requestId, text, entry)
      if (!text && !answer.media?.length)
        answer.text = entry ? NO_RESPONSE_TEXT : "AI 服務暫時無法使用，請稍後再試。"
      await deliver(answer, text ? pending.delivery : { ...pending.delivery, mode: "default" })
    }
  }
  async captureAnswer(requestId: string, entryId: EntryId): Promise<void> {
    await this.harness.commit(async (tx) => {
      const pending = (await tx.doc(OutboxDoc)).pending.find((item) => item.requestId === requestId)
      if (pending) pending.answerEntryId = entryId
    }, context)
  }
}
