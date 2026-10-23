import { type Context, InputFile } from "grammy"
import type { GeneratedMedia } from "../agent/durable/media.js"
import type { DurableAnswer } from "../agent/durable/outbox.js"
import type { ResponseDelivery } from "../agent/durable/state.js"
import type { ChatSessionRegistry, SubmissionCheckpoint } from "../agent/session-registry.js"
import type { createTelegramDelivery } from "./delivery.js"

export type MediaDeliverySessions = Pick<ChatSessionRegistry, "recordDelivery"> &
  Partial<
    Pick<
      ChatSessionRegistry,
      "assertResponseMediaAccess" | "readResponseImage" | "recordResponseComponent"
    >
  >

/** Cloud Bot API photo limits. Other valid originals use document upload, not conversion. */
export function telegramImageMethod(
  image: Pick<GeneratedMedia, "mimeType" | "byteLength" | "width" | "height">,
): "sendPhoto" | "sendDocument" {
  return ["image/png", "image/jpeg"].includes(image.mimeType) &&
    image.byteLength <= 10_000_000 &&
    image.width > 0 &&
    image.height > 0 &&
    image.width + image.height <= 10_000 &&
    Math.max(image.width, image.height) / Math.min(image.width, image.height) <= 20
    ? "sendPhoto"
    : "sendDocument"
}

/** Shared normal/recovery transport. Confirmed components are never uploaded again. */
export async function deliverGeneratedResponse(
  context: Context,
  sessions: MediaDeliverySessions,
  delivery: ReturnType<typeof createTelegramDelivery>,
  answer: DurableAnswer,
  checkpoint: SubmissionCheckpoint,
  saved: ResponseDelivery,
  isOwned: () => boolean,
): Promise<"delivered" | "unavailable" | "stale"> {
  const chatId = context.chat?.id
  if (chatId === undefined) throw new Error("Image delivery chat is unavailable")
  const authorize = async () => {
    if (!isOwned()) return false
    try {
      await sessions.assertResponseMediaAccess?.(chatId, checkpoint)
      return isOwned()
    } catch {
      return false
    }
  }
  const isCurrent = () => isOwned()
  if (!(await authorize()) || !isCurrent()) return "stale"
  if (!sessions.readResponseImage || !sessions.recordResponseComponent)
    throw new Error("Image delivery is unavailable")
  const options = {
    parse_mode: "HTML" as const,
    reply_parameters: { message_id: saved.sourceMessageId, allow_sending_without_reply: true },
  }
  const ids = [...(answer.textMessageIds ?? [])]
  // Generated images go directly to the user, independently of text/Morsel availability.
  for (const image of answer.media ?? []) {
    if (!(await authorize()) || !isCurrent()) return "stale"
    if (image.messageId !== undefined) {
      ids.push(image.messageId)
      continue
    }
    const bytes = await sessions.readResponseImage(chatId, checkpoint, image.id)
    if (!(await authorize()) || !isCurrent()) return "stale"
    const file = new InputFile(bytes, `${image.id}.${image.extension}`)
    const method = telegramImageMethod(image)
    // Never fall back or retry after an ambiguous upload: Telegram may have accepted it.
    const message = await context.api[method](chatId, file, {
      reply_parameters: options.reply_parameters,
    })
    if (!(await authorize()) || !isCurrent()) return "stale"
    await sessions.recordResponseComponent(chatId, checkpoint, image.id, message.message_id)
    ids.push(message.message_id)
  }
  if (!answer.textMessageIds?.length) {
    const text = answer.text || "圖片已生成。"
    const result =
      saved.statusMessageId === undefined
        ? await delivery.guardedReply(context, text, options, isCurrent, saved.mode, authorize)
        : await delivery.editOrReply(
            context,
            chatId,
            saved.statusMessageId,
            text,
            options,
            isCurrent,
            saved.mode,
            authorize,
          )
    if (!(await authorize()) || !isCurrent()) return "stale"
    if (result.result !== "delivered") return result.result
    const messageId = result.message?.message_id ?? saved.statusMessageId
    if (messageId === undefined) throw new Error("Image response text was not delivered")
    await sessions.recordResponseComponent(chatId, checkpoint, "text", messageId)
    ids.push(messageId)
  }
  if (!(await authorize()) || !isCurrent()) return "stale"
  await sessions.recordDelivery(chatId, checkpoint, ids)
  return "delivered"
}
