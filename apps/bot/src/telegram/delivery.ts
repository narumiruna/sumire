import type { Context } from "grammy"

import type { Logger } from "../logging.js"
import { MorselPublishError, type MorselPublisher, publishMorselWithTrace } from "../morsel.js"
import { messageText } from "./messages.js"
import { sanitizeTelegramText } from "./rendering.js"

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
        { "event.name": "morsel.publication.failed", error },
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
    authorize?: () => Promise<boolean>,
  ): Promise<{ result: EditResult; displayText?: string }> {
    // Provider checks can await I/O; check current ownership synchronously before sending.
    if (authorize && !(await authorize())) return { result: "stale" }
    if (!isCurrent()) return { result: "stale" }
    const message = await context.api.editMessageText(chatId, messageId, {
      markdown: prepared.text || " ",
    })
    if (authorize && !(await authorize())) return { result: "stale" }
    if (!isCurrent()) return { result: "stale" }
    return {
      result: prepared.delivered ? "delivered" : "unavailable",
      displayText: message === true ? prepared.text : messageText(message),
    }
  }

  async function sendPreparedAndClearPrevious(
    context: Context,
    chatId: number,
    messageId: number,
    prepared: Awaited<ReturnType<typeof prepare>>,
    options: Parameters<Context["replyWithRichMessage"]>[1],
    isCurrent: () => boolean,
    authorize?: () => Promise<boolean>,
  ) {
    if (authorize && !(await authorize())) return { result: "stale" as const }
    if (!isCurrent()) return { result: "stale" as const }
    const message = await richReply(context, prepared.text, options)
    if (authorize && !(await authorize())) return { message, result: "stale" as const }
    if (!isCurrent()) return { message, result: "stale" as const }
    // The original may still be visible, or may have been deleted already.
    let previousMessageUpdated = false
    try {
      await context.api.editMessageText(chatId, messageId, { markdown: "已改以新訊息回覆。" })
      previousMessageUpdated = true
    } catch (cleanupError) {
      logger.warn("Could not clear previous Telegram status", {
        "event.name": "telegram.status.clear.failed",
        "telegram.chat_id": chatId,
        "delivery.message_id": messageId,
        "delivery.method": "editMessageText",
        "delivery.stage": "clear_status",
        error: cleanupError,
      })
    }
    if (authorize && !(await authorize())) return { message, result: "stale" as const }
    if (!isCurrent()) return { message, result: "stale" as const }
    return {
      message,
      previousMessageUpdated,
      result: prepared.delivered ? ("delivered" as const) : ("unavailable" as const),
    }
  }

  return {
    // Compare sanitized Markdown source, not a second client-side rendering of native blocks.
    directPayload(text: string): string | undefined {
      const sanitized = sanitizeTelegramText(text)
      return Array.from(sanitized).length <= limit ? sanitized || " " : undefined
    },
    async reply(
      context: Context,
      text: string,
      options?: Parameters<Context["replyWithRichMessage"]>[1],
    ) {
      const prepared = await prepare(text)
      return richReply(context, prepared.text, options)
    },
    async guardedReply(
      context: Context,
      text: string,
      options: Parameters<Context["replyWithRichMessage"]>[1] | undefined,
      isCurrent: () => boolean,
      mode: DeliveryMode = "default",
      authorize?: () => Promise<boolean>,
    ) {
      if (!isCurrent()) return { result: "stale" as const }
      const prepared = await prepare(text, mode)
      if (authorize && !(await authorize())) return { result: "stale" as const }
      if (!isCurrent()) return { result: "stale" as const }
      const message = await richReply(context, prepared.text, options)
      if (authorize && !(await authorize())) return { message, result: "stale" as const }
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
      if (result.result !== "stale") onDelivered?.(result.displayText ?? prepared.text)
      return result.result
    },
    async editOrReply(
      context: Context,
      chatId: number,
      messageId: number,
      text: string,
      options: Parameters<Context["replyWithRichMessage"]>[1],
      isCurrent: () => boolean,
      mode: DeliveryMode = "default",
      authorize?: () => Promise<boolean>,
    ) {
      if (!isCurrent()) return { result: "stale" as const }
      const prepared = await prepare(text, mode)
      try {
        return {
          result: (await editPrepared(context, chatId, messageId, prepared, isCurrent, authorize))
            .result,
          message: undefined,
        }
      } catch (error) {
        logger.warn("Telegram edit failed; sending a new reply", {
          "event.name": "telegram.edit.failed",
          "telegram.chat_id": chatId,
          "delivery.message_id": messageId,
          "delivery.method": "editMessageText",
          "delivery.stage": "edit",
          error,
        })
        return sendPreparedAndClearPrevious(
          context,
          chatId,
          messageId,
          prepared,
          options,
          isCurrent,
          authorize,
        )
      }
    },
    async replyAndClearPrevious(
      context: Context,
      chatId: number,
      messageId: number,
      text: string,
      options: Parameters<Context["replyWithRichMessage"]>[1],
      isCurrent: () => boolean,
      mode: DeliveryMode = "default",
    ) {
      if (!isCurrent()) return { result: "stale" as const }
      const prepared = await prepare(text, mode)
      return sendPreparedAndClearPrevious(context, chatId, messageId, prepared, options, isCurrent)
    },
  }
}

function richReply(
  context: Context,
  text: string,
  options?: Parameters<Context["replyWithRichMessage"]>[1],
) {
  return context.replyWithRichMessage({ markdown: text || " " }, options)
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
