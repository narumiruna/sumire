import { type Bot, Context } from "grammy"

import type { ChatSessionRegistry } from "../agent/session-registry.js"
import type { createTelegramDelivery } from "./delivery.js"

export async function recoverTelegramResponses(
  bot: Bot,
  sessions: Pick<ChatSessionRegistry, "recover" | "recordDelivery">,
  delivery: ReturnType<typeof createTelegramDelivery>,
  chatIds: readonly number[],
): Promise<void> {
  await sessions.recover(chatIds, async (chatId, answer, saved, checkpoint, isCurrent) => {
    const recoveryContext = new Context(
      {
        update_id: 0,
        message: {
          message_id: saved.sourceMessageId,
          date: 0,
          from: { id: 0, is_bot: false, first_name: "Recovered sender" },
          chat: { id: chatId, type: "private", first_name: "Recovered chat" },
        },
      },
      bot.api,
      bot.botInfo,
    )
    const options = {
      reply_parameters: {
        message_id: saved.sourceMessageId,
        allow_sending_without_reply: true,
      },
    }
    const delivered =
      saved.statusMessageId === undefined
        ? await delivery.guardedReply(recoveryContext, answer.text, options, isCurrent, saved.mode)
        : await delivery.editOrReply(
            recoveryContext,
            chatId,
            saved.statusMessageId,
            answer.text,
            options,
            isCurrent,
            saved.mode,
          )
    if (delivered.result !== "delivered" || !isCurrent()) return false
    const messageId = delivered.message?.message_id ?? saved.statusMessageId
    if (messageId === undefined) return false
    await sessions.recordDelivery(chatId, checkpoint, [messageId])
    return true
  })
}
