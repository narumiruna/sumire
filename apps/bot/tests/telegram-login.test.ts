import { Bot } from "grammy"
import type { Update, UserFromGetMe } from "grammy/types"
import { describe, expect, it, vi } from "vitest"

import { registerOAuthCallbackGuard } from "../src/telegram/oauth-callbacks.js"

const authorizationUrl = "http://127.0.0.1:1455/auth/callback?code=fixture-secret"

function message(text: string): Update {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1_700_000_000,
      chat: { id: 7, type: "private", first_name: "Test" },
      from: { id: 7, is_bot: false, first_name: "Test" },
      text,
    },
  }
}

function setup(deletionFails = false) {
  const bot = new Bot("1:test", {
    botInfo: { id: 999, is_bot: true, first_name: "Test", username: "test_bot" } as UserFromGetMe,
  })
  registerOAuthCallbackGuard(bot)
  const forwarded = vi.fn()
  bot.on("message", forwarded)
  const calls: Array<{ method: string; payload: unknown }> = []
  bot.api.config.use(async (_previous, method, payload) => {
    calls.push({ method, payload })
    if (method === "deleteMessage" && deletionFails) throw new Error("Deletion denied")
    return { ok: true, result: true } as never
  })
  return { bot, forwarded, calls }
}

describe("Retired Telegram OAuth callback protection", () => {
  it.each([false, true])(
    "blocks authorization URLs even when deletion fails: %s",
    async (fails) => {
      const { bot, forwarded, calls } = setup(fails)
      await bot.handleUpdate(message(authorizationUrl))
      expect(forwarded).not.toHaveBeenCalled()
      expect(calls.map((call) => call.method)).toEqual(["deleteMessage", "sendMessage"])
      expect(JSON.stringify(calls)).not.toContain("fixture-secret")
      expect(JSON.stringify(calls)).toContain("Web UI")
    },
  )

  it.each(["text", "caption", "reply text", "reply caption"])(
    "blocks URLs in %s",
    async (location) => {
      const { bot, forwarded } = setup()
      const update = message("Summarize this")
      if (!update.message) throw new Error("Missing message")
      if (location === "text") update.message.text = `/f ${authorizationUrl}`
      else if (location === "caption") update.message.caption = authorizationUrl
      else {
        const source = message(authorizationUrl).message
        if (!source) throw new Error("Missing source")
        if (location === "reply caption") {
          delete source.text
          source.caption = authorizationUrl
        }
        update.message.reply_to_message = { ...source, reply_to_message: undefined }
      }
      await bot.handleUpdate(update)
      expect(forwarded).not.toHaveBeenCalled()
    },
  )

  it("passes ordinary messages to the remaining handlers", async () => {
    const { bot, forwarded, calls } = setup()
    await bot.handleUpdate(message("Hello"))
    expect(forwarded).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(0)
  })
})
