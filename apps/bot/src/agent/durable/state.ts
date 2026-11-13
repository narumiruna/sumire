import { randomUUID } from "node:crypto"

import type { JsonValue } from "@earendil-works/chord/json"
import { type ConversationId, defineDoc, type EntryId } from "@earendil-works/pi-durable"
import type { GeneratedMedia } from "./media.js"

export type BotSessionState = {
  sessionId: string
  activeConversation: number
  mainConversation: number
  trustKey: string
}

export function validateBotSessionState(value: unknown): BotSessionState {
  if (
    typeof value !== "object" ||
    value === null ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0 ||
    !("trustKey" in value) ||
    typeof value.trustKey !== "string" ||
    !("activeConversation" in value) ||
    typeof value.activeConversation !== "number" ||
    !Number.isSafeInteger(value.activeConversation) ||
    value.activeConversation <= 0 ||
    !("mainConversation" in value) ||
    typeof value.mainConversation !== "number" ||
    !Number.isSafeInteger(value.mainConversation) ||
    value.mainConversation <= 0
  )
    throw new Error("Invalid sumire.session state")
  return value as BotSessionState
}

export const BotSessionDoc = defineDoc({
  checkpointWhen: () => false,
  kind: "sumire.session",
  version: 2,
  scope: "session",
  initial: (): BotSessionState => ({
    sessionId: randomUUID(),
    activeConversation: 1,
    mainConversation: 1,
    trustKey: "",
  }),
  migrate: (value, fromVersion): BotSessionState => {
    if (fromVersion !== 1) throw new Error("Unsupported sumire.session version")
    return validateBotSessionState({ ...value, mainConversation: value.activeConversation })
  },
})

export type ConversationPurpose = "main" | "article" | "reply"

export const ConversationPurposeDoc = defineDoc({
  checkpointWhen: () => false,
  kind: "sumire.conversation",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ purpose: "main" as ConversationPurpose }),
})

export const ProgressDoc = defineDoc({
  checkpointWhen: () => false,
  kind: "sumire.progress",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({ steps: [] as Array<{ text: string; status: string }> }),
})

export const CodemodeStoreDoc = defineDoc({
  checkpointWhen: () => false,
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
  media?: GeneratedMedia[]
  textMessageIds?: number[]
  relatedRequestIds?: string[]
}

export const OutboxDoc = defineDoc({
  checkpointWhen: () => false,
  kind: "sumire.outbox",
  version: 1,
  scope: "session",
  initial: () => ({
    pending: [] as PendingResponse[],
    mediaReceipts: [] as Array<{ requestId: string; id: string; messageId: number }>,
  }),
})
