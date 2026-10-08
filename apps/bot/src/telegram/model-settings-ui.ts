import { isDeepStrictEqual } from "node:util"

import { type Context, GrammyError } from "grammy"
import type { InlineKeyboardMarkup } from "grammy/types"

import type { Logger } from "../logging.js"

const retentionMs = 5 * 60_000
const maxMessages = 256

type Content = { text: string; reply_markup: InlineKeyboardMarkup }

function contentOf(text: string, replyMarkup?: InlineKeyboardMarkup): Content {
  // InlineKeyboard is a builder class; compare plain Telegram payloads, not prototypes.
  return { text, reply_markup: { inline_keyboard: replyMarkup?.inline_keyboard ?? [] } }
}

/** Transport state belongs to one bot, not the session registry. No timers or retries. */
export function createModelSettingsUi(logger: Logger) {
  const busy = new Set<string>()
  const recent = new Map<string, { content: Content; expiresAt: number }>()
  let cooldownUntil = 0

  function coolingDown() {
    return Date.now() < cooldownUntil
  }

  function prune() {
    const now = Date.now()
    for (const [key, value] of recent) {
      if (value.expiresAt <= now) recent.delete(key)
    }
  }

  function remember(key: string, content: Content) {
    prune()
    recent.delete(key)
    recent.set(key, { content, expiresAt: Date.now() + retentionMs })
    if (recent.size > maxMessages) {
      const oldest = recent.keys().next().value
      if (oldest !== undefined) recent.delete(oldest)
    }
  }

  async function transport(
    operation: "acknowledge" | "reply" | "edit",
    action: () => Promise<unknown>,
  ) {
    if (coolingDown()) return false
    try {
      await action()
      return true
    } catch (error) {
      const errorCode = error instanceof GrammyError ? error.error_code : undefined
      const retryAfter = error instanceof GrammyError ? error.parameters.retry_after : undefined
      const validRetryAfter =
        typeof retryAfter === "number" && Number.isSafeInteger(retryAfter) && retryAfter > 0
          ? retryAfter
          : undefined
      if (errorCode === 429) {
        // A malformed limit response still stops immediate repeated requests.
        cooldownUntil = Math.max(cooldownUntil, Date.now() + (validRetryAfter ?? 1) * 1_000)
      }
      // Never export Telegram payloads, descriptions, upstream errors or URLs.
      logger.warn("Telegram model settings delivery failed", {
        operation,
        error_code: errorCode,
        retry_after: validRetryAfter,
      })
      return false
    }
  }

  async function reply(context: Context, text: string, replyMarkup?: InlineKeyboardMarkup) {
    const content = contentOf(text, replyMarkup)
    await transport("reply", async () => {
      const message = await context.reply(text, replyMarkup ? { reply_markup: replyMarkup } : {})
      remember(`${message.chat.id}:${message.message_id}`, content)
    })
  }

  async function edit(context: Context, text: string, replyMarkup?: InlineKeyboardMarkup) {
    const message = context.callbackQuery?.message
    if (!message || typeof message.text !== "string") return
    const key = `${message.chat.id}:${message.message_id}`
    const content = contentOf(text, replyMarkup)
    prune()
    // Successful local edits supersede stale callback message snapshots.
    const previous = recent.get(key)?.content ?? contentOf(message.text, message.reply_markup)
    if (isDeepStrictEqual(previous, content)) return
    await transport("edit", async () => {
      await context.editMessageText(text, { reply_markup: content.reply_markup })
      remember(key, content)
    })
  }

  async function callback(context: Context, action: () => Promise<void>) {
    const message = context.callbackQuery?.message
    if (!message || typeof message.text !== "string" || coolingDown()) return
    const key = `${message.chat.id}:${message.message_id}`
    if (busy.has(key)) {
      await transport("acknowledge", () => context.answerCallbackQuery())
      return
    }
    busy.add(key)
    try {
      const acknowledged = await transport("acknowledge", () => context.answerCallbackQuery())
      if (acknowledged && !coolingDown()) await action()
    } finally {
      busy.delete(key)
    }
  }

  return { coolingDown, reply, edit, callback }
}
