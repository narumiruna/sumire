import type { Context } from "grammy"

import type { Logger } from "../logging.js"
import { MorselPublishError, type MorselPublisher } from "../morsel.js"
import { sanitizeTelegramText, telegramHtmlChunks } from "./rendering.js"

export const maxTelegramMessageChars = 1_000
const maxPublicationFailureReasonChars = 200

type EditResult = "delivered" | "unavailable" | "stale"

export function createTelegramDelivery(
  publisher: Pick<MorselPublisher, "isConfigured" | "publish">,
  logger: Logger,
  threshold = maxTelegramMessageChars,
) {
  // Legacy settings may lower the threshold, but must never bypass the hard limit.
  const limit = Math.min(threshold, maxTelegramMessageChars)

  async function prepare(text: string): Promise<{ text: string; delivered: boolean }> {
    const sanitized = sanitizeTelegramText(text)
    const length = Array.from(sanitized).length
    if (length <= limit) return { text: sanitized, delivered: true }
    try {
      if (!publisher.isConfigured) throw new MorselPublishError("MORSEL_API_KEY is not configured")
      const url = await publisher.publish(sanitized)
      const notice = `完整訊息已發布至 Morsel（${length.toLocaleString("zh-TW")} 字）：\n${url}`
      if (Array.from(notice).length > maxTelegramMessageChars) {
        throw new MorselPublishError("Morsel share link exceeds the Telegram message limit")
      }
      return { text: notice, delivered: true }
    } catch (error) {
      logger.warn("Required Morsel publication failed; withholding long Telegram message", error)
      return { text: publicationFailure(error), delivered: false }
    }
  }

  return {
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
    ) {
      if (!isCurrent()) return { result: "stale" as const }
      const prepared = await prepare(text)
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
    ): Promise<EditResult> {
      if (!isCurrent()) return "stale"
      const prepared = await prepare(text)
      if (!isCurrent()) return "stale"
      await context.api.editMessageText(
        chatId,
        messageId,
        telegramHtmlChunks(prepared.text)[0] ?? " ",
        { parse_mode: "HTML" },
      )
      if (!isCurrent()) return "stale"
      return prepared.delivered ? "delivered" : "unavailable"
    },
  }
}

function publicationFailure(error: unknown): string {
  const rawReason = error instanceof Error ? error.message : "未知錯誤"
  const normalizedReason = sanitizeTelegramText(rawReason).replace(/\s+/gu, " ").trim()
  const reason =
    Array.from(normalizedReason).slice(0, maxPublicationFailureReasonChars).join("") || "未知錯誤"
  return `訊息超過 1,000 字，但 Morsel 暫時無法使用（原因：${reason}）；未傳送長文，請稍後再試。`
}
