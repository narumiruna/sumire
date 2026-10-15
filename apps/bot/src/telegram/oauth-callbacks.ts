import type { Bot } from "grammy"

/** Keep authorization URLs from the retired Telegram login flow out of model input. */
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
    if (!hasCallback) return next()
    try {
      await context.deleteMessage(telegramSignal())
    } catch {
      // Deletion is best effort. Never forward or log the authorization input.
    }
    try {
      await context.reply(
        "請在 Web UI 設定 provider 登入，不要將授權回覆網址傳送到 Telegram。",
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
