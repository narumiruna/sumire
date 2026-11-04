import type { Context } from "grammy"
import {
  MarketDataOutputError,
  maxMarketMessageChars,
  maxMarketReplies,
} from "../market-data/format.js"
import { sanitizeTelegramText } from "./rendering.js"

/** /t is public market data: native delivery only, never Morsel publication. */
export async function replyMarketData(
  context: Context,
  texts: readonly string[],
  options?: Parameters<Context["replyWithRichMessage"]>[1],
): Promise<void> {
  const messages = texts.map(sanitizeTelegramText).filter((text) => text.trim())
  if (!messages.length) messages.push("查不到市場資料，請確認代碼或稍後再試。")
  // Validate every part before sending any, so malformed overrides cannot cause partial delivery.
  if (
    messages.length > maxMarketReplies ||
    messages.some((text) => Array.from(text).length > maxMarketMessageChars)
  )
    throw new MarketDataOutputError()
  for (const markdown of messages) await context.replyWithRichMessage({ markdown }, options)
}
