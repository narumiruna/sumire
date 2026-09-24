import type { Context } from "grammy"

import type { Logger } from "../logging.js"
import { MorselPublishError, type MorselPublisher, publishMorselWithTrace } from "../morsel.js"
import { sanitizeTelegramText, telegramHtmlChunks, telegramVisibleText } from "./rendering.js"

export const maxTelegramMessageChars = 1_000
const maxPublicationFailureReasonChars = 200

export type DeliveryMode = "default" | "publish"
type EditResult = "delivered" | "unavailable" | "stale"

export function createTelegramDelivery(
  publisher: Pick<MorselPublisher, "isConfigured" | "publish">,
  logger: Logger,
  threshold = maxTelegramMessageChars,
) {
  // Legacy settings may lower the threshold, but must never bypass the hard limit.
  const limit = Math.min(threshold, maxTelegramMessageChars)

  async function prepare(
    text: string,
    mode: DeliveryMode = "default",
  ): Promise<{ text: string; delivered: boolean }> {
    const sanitized = sanitizeTelegramText(text)
    const length = Array.from(sanitized).length
    if (mode === "default" && length <= limit) return { text: sanitized, delivered: true }
    try {
      const url = await publishMorselWithTrace(publisher, sanitized, mode, logger)
      const notice =
        mode === "publish"
          ? url
          : `完整訊息已發布至 Morsel（${length.toLocaleString("zh-TW")} 字）：\n${url}`
      if (Array.from(notice).length > maxTelegramMessageChars) {
        throw new MorselPublishError("Morsel share link exceeds the Telegram message limit")
      }
      return { text: notice, delivered: true }
    } catch (error) {
      logger.warn(
        mode === "publish"
          ? "Required Morsel article publication failed; withholding generated article"
          : "Required Morsel publication failed; withholding long Telegram message",
        error,
      )
      return { text: morselPublicationFailure(error, mode), delivered: false }
    }
  }

  async function editPrepared(
    context: Context,
    chatId: number,
    messageId: number,
    prepared: Awaited<ReturnType<typeof prepare>>,
    isCurrent: () => boolean,
  ): Promise<EditResult> {
    if (!isCurrent()) return "stale"
    await context.api.editMessageText(
      chatId,
      messageId,
      telegramHtmlChunks(prepared.text)[0] ?? " ",
      { parse_mode: "HTML" },
    )
    if (!isCurrent()) return "stale"
    return prepared.delivered ? "delivered" : "unavailable"
  }

  async function sendPreparedAndClearPrevious(
    context: Context,
    chatId: number,
    messageId: number,
    prepared: Awaited<ReturnType<typeof prepare>>,
    options: Parameters<Context["reply"]>[1],
    isCurrent: () => boolean,
  ) {
    if (!isCurrent()) return { result: "stale" as const }
    const message = await context.reply(telegramHtmlChunks(prepared.text)[0] ?? " ", options)
    // The original may still be visible, or may have been deleted already.
    let previousMessageUpdated = false
    try {
      await context.api.editMessageText(chatId, messageId, "已改以新訊息回覆。", {
        parse_mode: "HTML",
      })
      previousMessageUpdated = true
    } catch (cleanupError) {
      logger.warn(`Could not clear previous Telegram status in chat_id=${chatId}`, cleanupError)
    }
    if (!isCurrent()) return { message, result: "stale" as const }
    return {
      message,
      previousMessageUpdated,
      result: prepared.delivered ? ("delivered" as const) : ("unavailable" as const),
    }
  }

  return {
    // Only direct replies have a predictable payload without publishing to Morsel.
    directPayload(text: string): string | undefined {
      const sanitized = sanitizeTelegramText(text)
      return Array.from(sanitized).length <= limit
        ? (telegramHtmlChunks(sanitized)[0] ?? " ")
        : undefined
    },
    async reply(context: Context, text: string, options?: Parameters<Context["reply"]>[1]) {
      const prepared = await prepare(text)
      return context.reply(
        options?.parse_mode === "HTML"
          ? (telegramHtmlChunks(prepared.text)[0] ?? " ")
          : prepared.text,
        options,
      )
    },
    async guardedReply(
      context: Context,
      text: string,
      options: Parameters<Context["reply"]>[1] | undefined,
      isCurrent: () => boolean,
      mode: DeliveryMode = "default",
    ) {
      if (!isCurrent()) return { result: "stale" as const }
      const prepared = await prepare(text, mode)
      if (!isCurrent()) return { result: "stale" as const }
      const message = await context.reply(
        options?.parse_mode === "HTML"
          ? (telegramHtmlChunks(prepared.text)[0] ?? " ")
          : prepared.text,
        options,
      )
      if (!isCurrent()) return { message, result: "stale" as const }
      return {
        message,
        result: prepared.delivered ? ("delivered" as const) : ("unavailable" as const),
      }
    },
    async edit(
      context: Context,
      chatId: number,
      messageId: number,
      text: string,
      isCurrent: () => boolean = () => true,
      mode: DeliveryMode = "default",
      onDelivered?: (visibleText: string) => void,
    ): Promise<EditResult> {
      if (!isCurrent()) return "stale"
      const prepared = await prepare(text, mode)
      const result = await editPrepared(context, chatId, messageId, prepared, isCurrent)
      if (result !== "stale") onDelivered?.(telegramVisibleText(prepared.text))
      return result
    },
    async editOrReply(
      context: Context,
      chatId: number,
      messageId: number,
      text: string,
      options: Parameters<Context["reply"]>[1],
      isCurrent: () => boolean,
      mode: DeliveryMode = "default",
    ) {
      if (!isCurrent()) return { result: "stale" as const }
      const prepared = await prepare(text, mode)
      try {
        return {
          result: await editPrepared(context, chatId, messageId, prepared, isCurrent),
          message: undefined,
        }
      } catch (error) {
        logger.warn(`Telegram edit failed for chat_id=${chatId}; sending a new reply`, error)
        return sendPreparedAndClearPrevious(
          context,
          chatId,
          messageId,
          prepared,
          options,
          isCurrent,
        )
      }
    },
    async replyAndClearPrevious(
      context: Context,
      chatId: number,
      messageId: number,
      text: string,
      options: Parameters<Context["reply"]>[1],
      isCurrent: () => boolean,
      mode: DeliveryMode = "default",
    ) {
      if (!isCurrent()) return { result: "stale" as const }
      const prepared = await prepare(text, mode)
      return sendPreparedAndClearPrevious(context, chatId, messageId, prepared, options, isCurrent)
    },
  }
}

export function morselPublicationFailure(error: unknown, mode: DeliveryMode): string {
  const rawReason = error instanceof Error ? error.message : "未知錯誤"
  const normalizedReason = sanitizeTelegramText(rawReason).replace(/\s+/gu, " ").trim()
  const reason =
    Array.from(normalizedReason).slice(0, maxPublicationFailureReasonChars).join("") || "未知錯誤"
  return mode === "publish"
    ? `文章無法發布至 Morsel（原因：${reason}），請稍後再試。`
    : `訊息超過 1,000 字，但 Morsel 暫時無法使用（原因：${reason}）；未傳送長文，請稍後再試。`
}
