import { randomUUID } from "node:crypto"
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import type { JsonObject, Message } from "@earendil-works/pi-ai"
import { AssistantEntry, type ConversationId, ToolTask } from "@earendil-works/pi-durable"

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

/** Execute a real Harness tool task without a model request or a second agent loop. */
export async function callDurableTool(session: DurableSession, name: string, args: JsonObject) {
  const conversation = await currentConversation(session)
  const task = await conversation.commit(async (tx) => {
    const callId = randomUUID()
    const assistant = await tx.appendEntry(AssistantEntry, conversation.id, {
      model: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: callId, name, arguments: args }],
          api: session.model.api,
          provider: session.model.provider,
          model: session.model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: Date.now(),
        },
      ],
    })
    return tx.createTask(
      ToolTask,
      { kind: "model", assistant: assistant.id, callId },
      {
        ownership: { kind: "conversation" },
      },
    )
  }, context)
  const settled = await session.harness.waitForTask(task, context)
  const outcome = settled.state.outcome
  if (!("result" in outcome) || !outcome.result || outcome.result.kind !== "model")
    throw new Error(`Tool fixture did not complete: ${JSON.stringify(outcome)}`)
  const { entryId } = outcome.result
  const entry = await session.harness.commit((tx) => tx.entry(entryId), context)
  const result = entry?.model?.find((message) => message.role === "toolResult")
  if (result?.role !== "toolResult") throw new Error("Missing durable tool result")
  return result
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
