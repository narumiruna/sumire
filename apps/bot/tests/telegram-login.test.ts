import { Bot } from "grammy"
import type { Update, UserFromGetMe } from "grammy/types"
import { describe, expect, it, vi } from "vitest"

import type { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { loadSettings } from "../src/config/settings.js"
import { createTelegramAgentBot } from "../src/telegram/bot.js"
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

function loginCommand(text: string, caption = false): Update {
  const update = message(text)
  if (!update.message) throw new Error("Missing message")
  const entities = [
    { type: "bot_command" as const, offset: 0, length: text.split(" ")[0]?.length ?? 0 },
  ]
  if (caption) {
    delete update.message.text
    update.message.caption = text
    update.message.caption_entities = entities
  } else update.message.entities = entities
  return update
}

function setup(deletionFails = false, replyFails = false) {
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
    if (method === "sendMessage" && replyFails) throw new Error("Delivery failed")
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

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "discards retired login input after delivery failures: delete=%s reply=%s",
    async (deletionFails, replyFails) => {
      const { bot, forwarded, calls } = setup(deletionFails, replyFails)
      await bot.handleUpdate(loginCommand("/login fixture-secret"))
      expect(forwarded).not.toHaveBeenCalled()
      expect(calls.map((call) => call.method)).toEqual(["deleteMessage", "sendMessage"])
      expect(JSON.stringify(calls)).not.toContain("fixture-secret")
      expect(JSON.stringify(calls)).toContain("/admin")
    },
  )

  it.each([
    ["/login", false, false],
    ["/login fixture-secret", false, false],
    ["/login@test_bot fixture-secret", false, false],
    ["/login fixture-secret", true, false],
    ["/login@test_bot fixture-secret", true, false],
    ["/login fixture-secret", false, true],
    ["/login@test_bot fixture-secret", true, true],
  ])(
    "blocks retired commands before bot submission: %s caption=%s group=%s",
    async (text, caption, group) => {
      const sessions = { submit: vi.fn(), appendPassiveContext: vi.fn() }
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
      const publish = vi.fn()
      const app = createTelegramAgentBot(
        loadSettings({ BOT_TOKEN: "1:test", BOT_WHITELIST: "7,-100" }),
        sessions as unknown as ChatSessionRegistry,
        logger,
        {
          botInfo: {
            id: 999,
            is_bot: true,
            first_name: "Test",
            username: "test_bot",
          } as UserFromGetMe,
          morselPublisher: { isConfigured: true, publish },
        },
      )
      const payloads: unknown[] = []
      app.bot.api.config.use(async (_previous, _method, payload) => {
        payloads.push(payload)
        return { ok: true, result: true } as never
      })
      const update = loginCommand(text, caption)
      if (group && update.message)
        update.message.chat = { id: -100, type: "supergroup", title: "Test" }
      await app.bot.handleUpdate(update)
      expect(sessions.submit).not.toHaveBeenCalled()
      expect(sessions.appendPassiveContext).not.toHaveBeenCalled()
      expect(publish).not.toHaveBeenCalled()
      expect(JSON.stringify(payloads)).not.toContain("fixture-secret")
      expect(JSON.stringify(payloads)).toContain("/admin")
      for (const log of Object.values(logger)) expect(log).not.toHaveBeenCalled()
      await app.stop()
    },
  )

  it("passes ordinary messages to the remaining handlers", async () => {
    const { bot, forwarded, calls } = setup()
    await bot.handleUpdate(message("Hello"))
    expect(forwarded).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(0)
  })
})
