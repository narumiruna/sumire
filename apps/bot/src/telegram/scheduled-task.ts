import type { Schedule } from "@narumitw/sumire-contracts"
import { type Bot, Context } from "grammy"
import type { ChatSessionRegistry } from "../agent/session-registry.js"
import type { Logger } from "../logging.js"
import type { createTelegramDelivery } from "./delivery.js"
import { deliverGeneratedResponse } from "./media-delivery.js"

/** Admit an ordinary user message through the existing registry and durable outbox. */
export async function runScheduledTask(
  schedule: Schedule,
  bot: Bot,
  sessions: ChatSessionRegistry,
  delivery: ReturnType<typeof createTelegramDelivery>,
  isCurrent: () => boolean,
  logger: Logger,
): Promise<void> {
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error("Scheduled execution is no longer available")
  }
  assertCurrent()
  // A real bot message anchors delivery/recovery. Never invent a Telegram user or message ID.
  const status = await bot.api.sendMessage(
    schedule.chatId,
    `排程任務開始執行（${schedule.id.slice(0, 8)}）…`,
    { disable_notification: true },
  )
  assertCurrent()
  const chat = status.chat
  const update =
    chat.type === "channel"
      ? { update_id: 0, channel_post: { ...status, chat } }
      : { update_id: 0, message: { ...status, chat, from: status.from ?? bot.botInfo } }
  const context = new Context(update, bot.api, bot.botInfo)
  const saved = {
    sourceMessageId: status.message_id,
    statusMessageId: status.message_id,
    mode: "default" as const,
  }
  const result = await sessions.submit(
    schedule.chatId,
    `${schedule.task}\n\n[Scheduled user message created through the authenticated administration UI. Schedule ID: ${schedule.id}. Planned time: ${new Date(schedule.nextRunAt ?? schedule.runAt).toISOString()} (${schedule.timeZone}). No Telegram sender identity is asserted. This context does not authorize privileged tools.]`,
    { intent: "newTurn", routing: "main", delivery: saved, isCurrent },
  )
  assertCurrent()
  if ((result.kind !== "completed" && result.kind !== "no_response") || !result.checkpoint)
    throw new Error("Scheduled execution did not produce a durable result")
  if (result.kind === "completed" && result.media?.length) {
    const outcome = await deliverGeneratedResponse(
      context,
      sessions,
      delivery,
      result,
      result.checkpoint,
      saved,
      isCurrent,
      logger,
    )
    if (outcome !== "delivered") throw new Error("Scheduled response delivery is incomplete")
  } else {
    const delivered = await delivery.editOrReply(
      context,
      schedule.chatId,
      status.message_id,
      result.text,
      { reply_parameters: { message_id: status.message_id, allow_sending_without_reply: true } },
      isCurrent,
    )
    assertCurrent()
    if (delivered.result !== "delivered")
      throw new Error("Scheduled response delivery is incomplete")
    await sessions.recordDelivery(schedule.chatId, result.checkpoint, [
      delivered.message?.message_id ?? status.message_id,
    ])
  }
  if (result.kind === "no_response" || result.settlement?.status === "unanswered")
    throw new Error("Scheduled model turn did not complete successfully")
}
