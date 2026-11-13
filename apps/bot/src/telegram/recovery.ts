import { type Bot, Context } from "grammy"

import { checkpointAttributes } from "../agent/durable/entries.js"
import type { ChatSessionRegistry } from "../agent/session-registry.js"
import {
  errorAttributes,
  isCancellation,
  type Logger,
  setSpanError,
  withLogSpan,
} from "../logging.js"
import type { createTelegramDelivery } from "./delivery.js"
import { deliverGeneratedResponse, type MediaDeliverySessions } from "./media-delivery.js"

export async function recoverTelegramResponses(
  bot: Bot,
  sessions: Pick<ChatSessionRegistry, "recover" | "recordDelivery"> & MediaDeliverySessions,
  delivery: ReturnType<typeof createTelegramDelivery>,
  chatIds: readonly number[],
  logger?: Logger,
): Promise<void> {
  await withLogSpan(
    logger,
    "telegram.recovery",
    {
      "recovery.chat_count": chatIds.length,
      "recovery.phase": "schedule",
    },
    async (root) => {
      try {
        await sessions.recover(chatIds, async (chatId, answer, saved, checkpoint, isCurrent) =>
          withLogSpan(
            logger,
            "telegram.recover_response",
            {
              "telegram.chat_id": chatId,
              "telegram.message_id": saved.sourceMessageId,
              ...(checkpoint ? checkpointAttributes(checkpoint) : {}),
              ...((checkpoint?.requestId ?? answer.requestId) === undefined
                ? {}
                : { "pi.request_id": (checkpoint?.requestId ?? answer.requestId) as string }),
            },
            async (span) => {
              let stage = answer.media?.length ? "media" : "text"
              const finish = (delivered: boolean, cancelled = false) => {
                const outcome = delivered
                  ? "delivered"
                  : cancelled || !isCurrent()
                    ? "cancelled"
                    : "incomplete"
                if (outcome === "incomplete")
                  setSpanError(span, { name: "RecoveryIncompleteError" })
                span.setAttribute("operation.outcome", outcome)
                span.setAttribute("recovery.outcome", outcome)
                if (!delivered) span.setAttribute("delivery.stage", stage)
                return delivered
              }
              try {
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
                if (answer.media?.length) {
                  if (!checkpoint) return finish(false)
                  const result = await deliverGeneratedResponse(
                    recoveryContext,
                    sessions,
                    delivery,
                    answer,
                    checkpoint,
                    saved,
                    isCurrent,
                    logger,
                  )
                  return finish(result === "delivered", result === "stale")
                }
                const options = {
                  reply_parameters: {
                    message_id: saved.sourceMessageId,
                    allow_sending_without_reply: true,
                  },
                }
                const delivered =
                  saved.statusMessageId === undefined
                    ? await delivery.guardedReply(
                        recoveryContext,
                        answer.text,
                        options,
                        isCurrent,
                        saved.mode,
                      )
                    : await delivery.editOrReply(
                        recoveryContext,
                        chatId,
                        saved.statusMessageId,
                        answer.text,
                        options,
                        isCurrent,
                        saved.mode,
                      )
                if (delivered.result !== "delivered" || !isCurrent()) {
                  return finish(false, delivered.result === "stale")
                }
                const messageId = delivered.message?.message_id ?? saved.statusMessageId
                if (messageId === undefined) return finish(false)
                span.setAttribute("delivery.message_id", messageId)
                stage = "ack"
                await sessions.recordDelivery(chatId, checkpoint, [messageId])
                return finish(true)
              } catch (error) {
                const metadata = errorAttributes(error)
                const cancelled = !isCurrent() || isCancellation(error)
                if (cancelled) {
                  for (const [key, value] of Object.entries(metadata)) span.setAttribute(key, value)
                  span.setAttribute("operation.outcome", "cancelled")
                  span.setAttribute("recovery.outcome", "cancelled")
                } else {
                  setSpanError(span, error)
                  span.setAttribute("recovery.outcome", "error")
                }
                span.setAttribute("delivery.stage", stage)
                throw error
              }
            },
          ),
        )
        // Registry recovery schedules background work; do not await it or repeat delivery here.
        root.setAttribute("operation.outcome", "scheduled")
        root.setAttribute("recovery.outcome", "scheduled")
      } catch (error) {
        setSpanError(root, error)
        root.setAttribute("recovery.outcome", "error")
        throw error
      }
    },
  )
}
