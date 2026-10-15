import type { Bot } from "grammy"

/** Keep retired login commands and authorization URLs out of model input. */
export function registerOAuthCallbackGuard(bot: Bot): void {
  bot.use(async (context, next) => {
    const message = context.message
    if (!message) return next()
    const hasCallback = [
      message.text,
      message.caption,
      message.reply_to_message?.text,
      message.reply_to_message?.caption,
    ].some((value) => value?.split(/\s+/u).some(isCallback))
    const captionEntity = message.caption_entities?.find(
      (entity) => entity.type === "bot_command" && entity.offset === 0,
    )
    const captionCommand = captionEntity
      ? message.caption?.slice(0, captionEntity.length)
      : undefined
    const retiredLogin =
      context.hasCommand("login") ||
      captionCommand === "/login" ||
      captionCommand === `/login@${context.me.username}`
    if (!hasCallback && !retiredLogin) return next()
    try {
      await context.deleteMessage(telegramSignal())
    } catch {
      // Deletion is best effort. Never forward or log the authorization input.
    }
    try {
      await context.reply(
        "Telegram login is no longer available. Use /admin to open the Web UI. Do not send credentials or authorization URLs to Telegram.",
        {},
        telegramSignal(),
      )
    } catch {
      // Delivery failure must not forward the authorization input either.
    }
  })
}

function telegramSignal(): NonNullable<Parameters<Bot["api"]["sendMessage"]>[3]> {
  return AbortSignal.timeout(30_000) as unknown as NonNullable<
    Parameters<Bot["api"]["sendMessage"]>[3]
  >
}

function isCallback(text: string): boolean {
  try {
    const url = new URL(text)
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      url.port === "1455" &&
      url.pathname === "/auth/callback"
    )
  } catch {
    return false
  }
}
