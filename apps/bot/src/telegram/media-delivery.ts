import { type Context, InputFile } from "grammy"
import type { GeneratedMedia } from "../agent/durable/media.js"
import type { DurableAnswer } from "../agent/durable/outbox.js"
import type { ResponseDelivery } from "../agent/durable/state.js"
import type { ChatSessionRegistry, SubmissionCheckpoint } from "../agent/session-registry.js"
import {
  errorAttributes,
  isCancellation,
  type Logger,
  setSpanError,
  type TraceSpan,
  withLogSpan,
} from "../logging.js"
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
  logger?: Logger,
): Promise<"delivered" | "unavailable" | "stale"> {
  const chatId = context.chat?.id
  const attributes = {
    "telegram.message_id": saved.sourceMessageId,
    "pi.session_id": checkpoint.sessionId,
    ...(chatId === undefined ? {} : { "telegram.chat_id": chatId }),
    ...(checkpoint.requestId === undefined ? {} : { "pi.request_id": checkpoint.requestId }),
  }
  return withLogSpan(logger, "telegram.deliver", attributes, async (span) => {
    let stage = "authorization"
    let confirmed = answer.textMessageIds?.length ?? 0
    let totalBytes = 0
    const fail = (target: TraceSpan, error: unknown) => {
      const metadata = errorAttributes(error)
      const cancelled = !isOwned() || isCancellation(error)
      if (cancelled) {
        for (const [key, value] of Object.entries(metadata)) target.setAttribute(key, value)
        target.setAttribute("operation.outcome", "cancelled")
      } else setSpanError(target, error)
      target.setAttribute("delivery.outcome", cancelled ? "cancelled" : "error")
      target.setAttribute("delivery.stage", stage)
    }
    const finish = (result: "delivered" | "unavailable" | "stale") => {
      const outcome =
        result === "stale" ? "cancelled" : result === "unavailable" ? "incomplete" : "delivered"
      if (outcome === "incomplete") setSpanError(span, { name: "DeliveryIncompleteError" })
      span.setAttribute("operation.outcome", outcome)
      span.setAttribute("delivery.outcome", outcome)
      if (result !== "delivered") span.setAttribute("delivery.stage", stage)
      return result
    }
    try {
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
      if (!(await authorize()) || !isCurrent()) return finish("stale")
      const readImage = sessions.readResponseImage?.bind(sessions)
      const recordComponent = sessions.recordResponseComponent?.bind(sessions)
      if (!readImage || !recordComponent) throw new Error("Image delivery is unavailable")
      const options = {
        reply_parameters: { message_id: saved.sourceMessageId, allow_sending_without_reply: true },
      }
      const ids = [...(answer.textMessageIds ?? [])]
      // Generated images go directly to the user, independently of text/Morsel availability.
      for (const image of answer.media ?? []) {
        stage = "authorization"
        if (!(await authorize()) || !isCurrent()) return finish("stale")
        const result = await withLogSpan(
          logger,
          "telegram.deliver.component",
          {
            ...attributes,
            "delivery.component_id": image.id,
            "delivery.component_kind": "image",
            "delivery.method": telegramImageMethod(image),
            "delivery.bytes": image.byteLength,
          },
          async (component) => {
            try {
              if (image.messageId !== undefined) {
                ids.push(image.messageId)
                confirmed++
                component.setAttribute("delivery.message_id", image.messageId)
                component.setAttribute("operation.outcome", "confirmed")
                component.setAttribute("delivery.outcome", "confirmed")
                return "delivered" as const
              }
              stage = "read"
              const bytes = await readImage(chatId, checkpoint, image.id)
              totalBytes += bytes.byteLength
              component.setAttribute("delivery.bytes", bytes.byteLength)
              if (!(await authorize()) || !isCurrent()) {
                component.setAttribute("operation.outcome", "cancelled")
                component.setAttribute("delivery.outcome", "cancelled")
                component.setAttribute("delivery.stage", stage)
                return "stale" as const
              }
              const file = new InputFile(bytes, `${image.id}.${image.extension}`)
              stage = "upload"
              // Never fall back or retry after an ambiguous upload: Telegram may have accepted it.
              const message = await context.api[telegramImageMethod(image)](chatId, file, {
                reply_parameters: options.reply_parameters,
              })
              confirmed++
              component.setAttribute("delivery.message_id", message.message_id)
              if (!(await authorize()) || !isCurrent()) {
                component.setAttribute("operation.outcome", "cancelled")
                component.setAttribute("delivery.outcome", "cancelled")
                component.setAttribute("delivery.stage", stage)
                return "stale" as const
              }
              stage = "receipt"
              await recordComponent(chatId, checkpoint, image.id, message.message_id)
              ids.push(message.message_id)
              component.setAttribute("operation.outcome", "delivered")
              component.setAttribute("delivery.outcome", "delivered")
              return "delivered" as const
            } catch (error) {
              fail(component, error)
              throw error
            }
          },
        )
        if (result === "stale") return finish(result)
      }
      if (!answer.textMessageIds?.length) {
        const result = await withLogSpan(
          logger,
          "telegram.deliver.component",
          {
            ...attributes,
            "delivery.component_id": "text",
            "delivery.component_kind": "text",
            "delivery.method": "text",
          },
          async (component) => {
            try {
              stage = "text"
              const text = answer.text || "圖片已生成。"
              const delivered =
                saved.statusMessageId === undefined
                  ? await delivery.guardedReply(
                      context,
                      text,
                      options,
                      isCurrent,
                      saved.mode,
                      authorize,
                    )
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
              const messageId = delivered.message?.message_id ?? saved.statusMessageId
              if (delivered.result === "delivered" && messageId !== undefined) {
                component.setAttribute("delivery.message_id", messageId)
                confirmed++
              }
              if (!(await authorize()) || !isCurrent()) {
                component.setAttribute("operation.outcome", "cancelled")
                component.setAttribute("delivery.outcome", "cancelled")
                component.setAttribute("delivery.stage", stage)
                return "stale" as const
              }
              if (delivered.result !== "delivered") {
                const outcome = delivered.result === "stale" ? "cancelled" : "incomplete"
                if (outcome === "incomplete")
                  setSpanError(component, { name: "DeliveryIncompleteError" })
                component.setAttribute("operation.outcome", outcome)
                component.setAttribute("delivery.outcome", outcome)
                component.setAttribute("delivery.stage", stage)
                return delivered.result
              }
              if (messageId === undefined) throw new Error("Image response text was not delivered")
              stage = "receipt"
              await recordComponent(chatId, checkpoint, "text", messageId)
              ids.push(messageId)
              component.setAttribute("operation.outcome", "delivered")
              component.setAttribute("delivery.outcome", "delivered")
              return "delivered" as const
            } catch (error) {
              fail(component, error)
              throw error
            }
          },
        )
        if (result !== "delivered") return finish(result)
      }
      stage = "ack"
      if (!(await authorize()) || !isCurrent()) return finish("stale")
      await sessions.recordDelivery(chatId, checkpoint, ids)
      return finish("delivered")
    } catch (error) {
      fail(span, error)
      throw error
    } finally {
      span.setAttribute("delivery.confirmed_components", confirmed)
      span.setAttribute("delivery.bytes", totalBytes)
    }
  })
}
