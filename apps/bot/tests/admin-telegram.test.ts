import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Update, UserFromGetMe } from "grammy/types"
import { expect, it, vi } from "vitest"
import type { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { loadSettings } from "../src/config/settings.js"
import type { DocumentConverter } from "../src/documents/converter.js"
import { createTelegramAgentBot } from "../src/telegram/bot.js"
import { TestAdminStore as AdminStore } from "./helpers/admin-store.js"

it("rejects unapproved chats before attachments, commands, callbacks, or passive context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sumire-admin-telegram-"))
  const store = new AdminStore(path.join(root, "admin.sqlite"), new Set([42]), 42)
  store.applied(1, true)
  const sessions = {
    submit: vi.fn(),
    appendPassiveContext: vi.fn(),
    reset: vi.fn(),
  } as unknown as ChatSessionRegistry
  const converter = { convert: vi.fn() } as unknown as DocumentConverter
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const telegram = createTelegramAgentBot(
    loadSettings({ BOT_ADMIN_ID: "7", BOT_TOKEN: "fixture" }, root),
    sessions,
    logger,
    {
      botInfo: {
        id: 999,
        is_bot: true,
        username: "fixture_bot",
        first_name: "Fixture",
      } as UserFromGetMe,
      control: store,
      documentConverter: converter,
    },
  )
  const api = vi.fn()
  telegram.bot.api.config.use(async () => {
    api()
    throw new Error("Unexpected API request")
  })
  const from = { id: 42, is_bot: false, first_name: "Fixture" }
  try {
    for (const text of ["@fixture_bot hello", "passive context", "/model", "/reset"]) {
      await telegram.bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: 1,
          from,
          chat: { id: -100, type: "supergroup", title: "Unapproved group" },
          text,
          entities: text.startsWith("/")
            ? [{ type: "bot_command", offset: 0, length: text.length }]
            : [],
        },
      })
    }
    await telegram.bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        date: 1,
        from: { ...from, id: 43 },
        chat: { id: 43, type: "private", first_name: "Denied" },
        document: { file_id: "fixture", file_unique_id: "fixture", file_name: "fixture.pdf" },
      },
    })
    await telegram.bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "fixture",
        from,
        chat_instance: "fixture",
        data: "model:fixture",
        message: {
          message_id: 3,
          date: 1,
          chat: { id: -100, type: "supergroup", title: "Denied" },
          text: "fixture",
        },
      },
    } as Update)
    expect(sessions.submit).not.toHaveBeenCalled()
    expect(sessions.appendPassiveContext).not.toHaveBeenCalled()
    expect(sessions.reset).not.toHaveBeenCalled()
    expect(converter.convert).not.toHaveBeenCalled()
    expect(api).not.toHaveBeenCalled()
  } finally {
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})
