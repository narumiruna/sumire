import { randomUUID } from "node:crypto"
import type { Bot, Context } from "grammy"
import type { InlineKeyboardMarkup } from "grammy/types"

import type { Logger } from "../logging.js"

export interface AbortButton {
  replyMarkup?: InlineKeyboardMarkup
  trackMessage(messageId: number): void
  close(): Promise<void>
}

/** Transport-only controls; the existing chat cancellation path owns the actual abort. */
export function registerAbortButtons(
  bot: Bot,
  options: {
    allows: (chatId: number) => boolean
    adminId?: number
    cancel: (chatId: number) => Promise<boolean>
    logger: Logger
  },
): (context: Context, isCurrent: () => boolean) => AbortButton {
  const active = new Map<
    string,
    { chatId: number; ownerId: number; messageIds: Set<number>; isCurrent: () => boolean }
  >()

  bot.callbackQuery(/^abort:/u, async (context) => {
    const message = context.callbackQuery.message
    const entry = active.get(context.callbackQuery.data)
    const chat = context.chat
    if (
      !entry ||
      !message ||
      message.from?.id !== context.me.id ||
      chat?.id !== entry.chatId ||
      !entry.messageIds.has(message.message_id) ||
      !entry.isCurrent()
    ) {
      await context.answerCallbackQuery({ text: "此任務已結束或按鈕已過期。" })
      return
    }
    if (
      !options.allows(chat.id) ||
      context.from.is_bot ||
      (chat.type === "private" && context.from.id !== chat.id) ||
      (context.from.id !== entry.ownerId && context.from.id !== options.adminId)
    ) {
      await context.answerCallbackQuery({
        text: "只有發起者或 bot 管理員可以停止此對話的任務。",
        show_alert: true,
      })
      return
    }

    // cancel() invalidates the chat generation synchronously, before acknowledgement I/O.
    // Attach the rejection handler immediately: Telegram acknowledgement can itself fail.
    const cancellation = options.cancel(chat.id).then(
      () => true,
      (error: unknown) => {
        options.logger.warn("Telegram abort button cancellation failed", error)
        return false
      },
    )
    try {
      await context.answerCallbackQuery({ text: "已送出停止此對話所有任務的要求。" })
    } catch (error) {
      options.logger.warn("Could not acknowledge Telegram abort button", error)
    }
    if (!(await cancellation)) await context.reply("停止任務時發生錯誤，請稍後使用 /cancel 重試。")
  })

  return (context, isCurrent) => {
    const chatId = context.chat?.id
    const ownerId = context.from?.id
    if (
      chatId === undefined ||
      ownerId === undefined ||
      context.from?.is_bot ||
      context.message?.sender_chat
    )
      return { trackMessage() {}, async close() {} }

    const token = `abort:${randomUUID()}`
    const messageIds = new Set<number>()
    active.set(token, { chatId, ownerId, messageIds, isCurrent })
    let closing: Promise<void> | undefined
    return {
      replyMarkup: {
        inline_keyboard: [[{ text: "⏹ Abort streaming", callback_data: token }]],
      },
      trackMessage(messageId) {
        messageIds.add(messageId)
      },
      close() {
        active.delete(token)
        closing ??= (async () => {
          for (const messageId of messageIds) {
            try {
              await context.api.editMessageReplyMarkup(
                chatId,
                messageId,
                { reply_markup: { inline_keyboard: [] } },
                AbortSignal.timeout(5_000) as unknown as Parameters<
                  typeof context.api.editMessageReplyMarkup
                >[3],
              )
            } catch (error) {
              // Deleted messages and transient Telegram failures must not lose the answer.
              options.logger.warn("Could not remove Telegram abort button", error)
            }
          }
        })()
        return closing
      },
    }
  }
}
