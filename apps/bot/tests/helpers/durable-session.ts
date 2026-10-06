import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import type { Message } from "@earendil-works/pi-ai"
import type { ConversationId } from "@earendil-works/pi-durable"

import type { DurableSession } from "../../src/agent/durable-session.js"
import { BotSessionDoc } from "../../src/agent/durable-state.js"

export async function currentConversation(session: DurableSession) {
  const state = await session.harness.snapshot(BotSessionDoc, context)
  const conversation = await session.harness.conversation(
    state?.activeConversation as ConversationId,
    context,
  )
  if (!conversation) throw new Error("Missing durable fixture conversation")
  return conversation
}

export async function appendMessage(session: DurableSession, message: Message): Promise<string> {
  const conversation = await currentConversation(session)
  const entry = await conversation.commit(
    (tx) => tx.appendEntry(conversation.id, { kind: "message", model: [message] }),
    context,
  )
  await session.waitForIdle()
  return `${entry.conversationId}:${entry.id}`
}
