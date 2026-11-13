import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import {
  AssistantEntry,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Harness,
  LiveDoc,
  type SubmissionRecord,
  type UserInput,
} from "@earendil-works/pi-durable"
import { assistantText, checkpointId } from "./entries.js"
import type { GeneratedMedia, GeneratedMediaFiles } from "./media.js"
import { OutboxDoc, type PendingResponse, type ResponseDelivery } from "./state.js"

export type DurableAnswer = {
  text: string
  entryId?: string
  inputEntryId?: string
  requestId?: string
  media?: GeneratedMedia[]
  textMessageIds?: number[]
}
export const NO_RESPONSE_TEXT = "模型沒有回覆內容，請稍後再試。"
export const MAX_CONCURRENT_DELIVERIES = 4

/** Persist response components. Only the transport can acknowledge complete delivery. */
export class DurableOutbox {
  constructor(
    private readonly harness: Harness,
    private readonly files?: GeneratedMediaFiles,
    private readonly beforeSubmit?: (pending: PendingResponse) => Promise<() => void>,
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
  async waitForRelated(requestId: string): Promise<void> {
    const pending = (await this.harness.snapshot(OutboxDoc, context))?.pending.find(
      (item) => item.requestId === requestId,
    )
    if (pending && (await this.relatedBusy(pending)))
      await (await this.harness.conversation(pending.conversationId, context))?.waitForIdle(context)
  }

  private async relatedBusy(pending: PendingResponse): Promise<boolean> {
    if (!pending.relatedRequestIds?.length) return false
    const unfinished = await this.harness.commit(async (tx) => {
      for (const id of pending.relatedRequestIds ?? []) {
        const input = await tx.submissionByRequest(pending.conversationId, id)
        if (input && input.status !== "done" && input.status !== "unanswered") return true
      }
      return false
    }, context)
    return (
      unfinished &&
      Boolean((await this.harness.snapshot(LiveDoc, pending.conversationId, context))?.run)
    )
  }

  async recoverPending(
    deliver: (answer: DurableAnswer, delivery: ResponseDelivery) => Promise<void>,
    isClosing: () => boolean,
  ): Promise<void> {
    if (isClosing()) return
    const remaining = new Set(
      (await this.harness.snapshot(OutboxDoc, context))?.pending.map((item) => item.requestId),
    )
    const active = new Set<Promise<void>>()
    const admissions = new Map<string, Promise<void>>()
    const errors: unknown[] = []
    let revision = 0
    let wake: (() => void) | undefined
    let ended = false
    const notify = () => {
      revision++
      wake?.()
      wake = undefined
    }
    // One subscription serves every request. Running submissions do not occupy delivery slots.
    const observation = this.harness.observeCommits({
      advance: (publication) => {
        if (
          publication.changes.some(
            (change) =>
              change.type === "submission" ||
              (change.type === "document" && change.record.kind === OutboxDoc.definition.kind),
          )
        )
          notify()
      },
      end: (end) => {
        ended = true
        if (end.kind === "failed" && !isClosing()) errors.push(end.error)
        notify()
      },
    })
    try {
      this.harness.resume()
      while (remaining.size && !isClosing() && !ended) {
        const before = revision
        const current = (await this.harness.snapshot(OutboxDoc, context))?.pending ?? []
        const present = new Set(current.map((item) => item.requestId))
        for (const id of remaining) if (!present.has(id)) remaining.delete(id)
        for (const pending of current) {
          if (isClosing() || ended || active.size >= MAX_CONCURRENT_DELIVERIES) break
          if (!remaining.has(pending.requestId)) continue
          try {
            const conversation = await this.harness.conversation(pending.conversationId, context)
            if (!conversation) throw new Error("Durable outbox conversation is missing")
            if (this.beforeSubmit && pending.answerEntryId === undefined) {
              const saved = await this.harness.commit(
                (tx) => tx.submissionByRequest(pending.conversationId, pending.requestId),
                context,
              )
              if (!saved) {
                if (!admissions.has(pending.requestId)) {
                  admissions.set(
                    pending.requestId,
                    this.admitPending(pending, isClosing)
                      .catch((error: unknown) => {
                        errors.push(error)
                        remaining.delete(pending.requestId)
                      })
                      .finally(notify),
                  )
                }
                continue
              }
            }
            const id = await this.harness.commit(async (tx) => {
              // Cancellation and admission share the same commit, including unsent delivery intents.
              const current = (await tx.doc(OutboxDoc)).pending.find(
                (item) => item.requestId === pending.requestId,
              )
              if (isClosing() || !current) return undefined
              const saved = await tx.submissionByRequest(pending.conversationId, pending.requestId)
              if (saved) return saved.id
              // A saved answer without its native submission cannot authorize model replay.
              if (current.answerEntryId !== undefined) return null
              return conversation.submit(tx, {
                type: "input",
                requestId: pending.requestId,
                content: pending.content as UserInput,
              })
            }, context)
            if (id === undefined) {
              remaining.delete(pending.requestId)
              continue
            }
            const submission = id === null ? undefined : await this.harness.submission(id, context)
            if (id !== null && !submission) throw new Error("Durable outbox submission is missing")
            const settled = await submission?.status(context)
            if (settled && settled.status !== "done" && settled.status !== "unanswered") continue
            if (await this.relatedBusy(pending)) continue
            remaining.delete(pending.requestId)
            const task = this.recoverAnswer(pending, settled, deliver, isClosing)
              .catch((error: unknown) => {
                errors.push(error)
              })
              .finally(() => {
                active.delete(task)
                notify()
              })
            active.add(task)
          } catch (error) {
            remaining.delete(pending.requestId)
            errors.push(error)
          }
        }
        if (remaining.size && !isClosing() && !ended && revision === before)
          await new Promise<void>((resolve) => {
            wake = resolve
          })
      }
    } catch (error) {
      errors.push(error)
    } finally {
      // A failed delivery must not release the Harness owner while peer deliveries still run.
      await Promise.allSettled([...active, ...admissions.values()])
      observation.detach()
    }
    if (errors.length) throw new AggregateError(errors, "Durable outbox recovery failed")
  }
  private async admitPending(pending: PendingResponse, isClosing: () => boolean): Promise<void> {
    const release = await this.beforeSubmit?.(pending)
    let admitted = false
    try {
      if (isClosing()) return
      const conversation = await this.harness.conversation(pending.conversationId, context)
      if (!conversation) throw new Error("Durable outbox conversation is missing")
      const id = await this.harness.commit(async (tx) => {
        const current = (await tx.doc(OutboxDoc)).pending.find(
          (item) => item.requestId === pending.requestId,
        )
        if (!current || isClosing()) return undefined
        const saved = await tx.submissionByRequest(pending.conversationId, pending.requestId)
        if (saved) return saved.id
        return conversation.submit(tx, {
          type: "input",
          requestId: pending.requestId,
          content: current.content as UserInput,
        })
      }, context)
      if (id !== undefined) {
        admitted = true
        void conversation.waitForIdle(context).then(release, release)
      }
    } finally {
      if (!admitted) release?.()
    }
  }

  private async recoverAnswer(
    pending: PendingResponse,
    settled: SubmissionRecord | undefined,
    deliver: (answer: DurableAnswer, delivery: ResponseDelivery) => Promise<void>,
    isClosing: () => boolean,
  ): Promise<void> {
    const entry = await this.harness.commit(async (tx) => {
      const current = (await tx.doc(OutboxDoc)).pending.find(
        (item) => item.requestId === pending.requestId,
      )
      if (!current || isClosing()) return undefined
      const native =
        settled?.type === "input" && settled.status === "done"
          ? await tx.entry(AssistantEntry, settled.answer)
          : undefined
      const entry = native?.conversationId === pending.conversationId ? native : undefined
      // The native terminal submission is authoritative, including for old, incorrect caches.
      if (entry) current.answerEntryId = entry.id
      else if (settled) delete current.answerEntryId
      // If the native submission is missing, retain the invalid cache only to prevent replay.
      // It is never used as an answer or a reply checkpoint.
      return entry
    }, context)
    const text = assistantText(entry)
    const answer = await this.answer(pending.requestId, text, entry)
    if (settled?.type === "input" && settled.entry !== undefined) {
      const input = await this.harness.commit((tx) => tx.entry(settled.entry as EntryId), context)
      if (input?.conversationId === pending.conversationId)
        answer.inputEntryId = checkpointId(input)
    }
    if (!text && !answer.media?.length)
      answer.text = entry ? NO_RESPONSE_TEXT : "AI 服務暫時無法使用，請稍後再試。"
    const current = (await this.harness.snapshot(OutboxDoc, context))?.pending.find(
      (item) => item.requestId === pending.requestId,
    )
    if (!current || isClosing()) return
    await deliver(answer, text ? current.delivery : { ...current.delivery, mode: "default" })
  }
  async captureAnswer(requestId: string, entryId: EntryId): Promise<void> {
    await this.harness.commit(async (tx) => {
      const pending = (await tx.doc(OutboxDoc)).pending.find((item) => item.requestId === requestId)
      if (pending) pending.answerEntryId = entryId
    }, context)
  }
}
