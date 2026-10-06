import { randomUUID } from "node:crypto"

import type { JsonValue } from "@earendil-works/chord"
import { type ConversationId, defineDoc, type EntryId } from "@earendil-works/pi-durable"

export const BotSessionDoc = defineDoc({
  kind: "sumire.session",
  version: 1,
  scope: "session",
  initial: () => ({ sessionId: randomUUID(), activeConversation: 1, trustKey: "" }),
})

export const ProgressDoc = defineDoc({
  kind: "sumire.progress",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ steps: [] as Array<{ text: string; status: string; reason?: string }> }),
})

export const CodemodeStoreDoc = defineDoc({
  kind: "sumire.codemode-store",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ values: {} as Record<string, JsonValue> }),
})

export type ResponseDelivery = {
  sourceMessageId: number
  statusMessageId?: number
  mode: "default" | "publish"
}

export type PendingResponse = {
  requestId: string
  conversationId: ConversationId
  content: JsonValue
  delivery: ResponseDelivery
  answerEntryId?: EntryId
}

export const OutboxDoc = defineDoc({
  kind: "sumire.outbox",
  version: 1,
  scope: "session",
  initial: () => ({ pending: [] as PendingResponse[] }),
})
