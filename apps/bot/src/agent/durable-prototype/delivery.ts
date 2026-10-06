import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import {
  defineDoc,
  type EntryId,
  type Harness,
  type SettledSubmissionRecord,
  type SubmissionId,
  type ConversationId,
} from "@earendil-works/pi-durable"

type DeliveryRecord = {
  submissionId: SubmissionId
  conversationId: ConversationId
  sourceMessageId: number
  statusMessageId: number | null
  answerId: EntryId
  outcome: "pending" | "uncertain" | "delivered"
  messageId: number | null
}
export const Deliveries = defineDoc<{ records: DeliveryRecord[] }>({
  kind: "sumire.deliveries",
  version: 1,
  scope: "session",
  initial: () => ({ records: [] }),
})

export async function queueDelivery(
  harness: Harness,
  record: SettledSubmissionRecord,
  sourceMessageId: number,
  statusMessageId: number | null = null,
) {
  if (record.status !== "done" || record.type !== "input")
    throw new Error("Cannot deliver unanswered input")
  await harness.commit(async (tx) => {
    const deliveries = await tx.doc(Deliveries)
    if (!deliveries.records.some((item) => item.submissionId === record.id)) {
      deliveries.records.push({
        submissionId: record.id,
        conversationId: record.conversationId,
        sourceMessageId,
        statusMessageId,
        answerId: record.answer,
        outcome: "pending",
        messageId: null,
      })
    }
  }, context)
}

/** The sender is a test double; production Telegram and Morsel are never called. */
export async function deliver(
  harness: Harness,
  id: SubmissionId,
  send: () => Promise<number>,
  afterSend?: () => Promise<void>,
) {
  const claimed = await harness.commit(async (tx) => {
    const item = (await tx.doc(Deliveries)).records.find((record) => record.submissionId === id)
    if (item?.outcome !== "pending") return false
    item.outcome = "uncertain"
    return true
  }, context)
  if (!claimed) return false
  const messageId = await send()
  await afterSend?.()
  await harness.commit(async (tx) => {
    const item = (await tx.doc(Deliveries)).records.find((record) => record.submissionId === id)
    if (!item) throw new Error("Missing delivery receipt")
    item.outcome = "delivered"
    item.messageId = messageId
  }, context)
  return true
}
