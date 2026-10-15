import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Update, UserFromGetMe } from "grammy/types"
import { afterEach, expect, it, vi } from "vitest"
import { AdminStore } from "../src/admin/store.js"
import type { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { loadSettings } from "../src/config/settings.js"
import { createTelegramAgentBot } from "../src/telegram/bot.js"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
async function setup(enabled = true, administrator = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "sumire-admin-command-"))
  const store = new AdminStore(path.join(root, "admin.sqlite"), new Set(), 42)
  const sessions = {
    submit: vi.fn(),
    appendPassiveContext: vi.fn(),
  } as unknown as ChatSessionRegistry
  const telegram = createTelegramAgentBot(
    loadSettings(
      {
        BOT_TOKEN: "fixture",
        BOT_WHITELIST: "42,43,-100",
        ...(administrator ? { BOT_ADMIN_ID: "42" } : {}),
        ...(enabled
          ? {
              ADMIN_ORIGIN: "https://admin.example.test",
              TELEGRAM_LOGIN_CLIENT_ID: "fixture",
              TELEGRAM_LOGIN_CLIENT_SECRET: "fixture",
            }
          : {}),
      },
      root,
    ),
    sessions,
    { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    {
      botInfo: {
        id: 999,
        is_bot: true,
        username: "fixture_bot",
        first_name: "Fixture",
      } as UserFromGetMe,
      control: store,
    },
  )
  cleanup.push(async () => {
    await telegram.stop()
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  telegram.bot.api.config.use(async (_previous, method, payload) => {
    const data = payload as Record<string, unknown>
    calls.push({ method, payload: data })
    if (method === "sendMessage")
      return {
        ok: true,
        result: {
          message_id: 10,
          date: 1,
          chat: { id: data.chat_id, type: "private", first_name: "Fixture" },
          text: data.text,
        },
      } as never
    return { ok: true, result: true } as never
  })
  return { telegram, store, sessions, calls }
}
function command(text = "/admin", sender = 42, group = false): Update {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      from: { id: sender, is_bot: false, first_name: "Fixture" },
      chat: group
        ? { id: -100, type: "supergroup", title: "Fixture" }
        : { id: sender, type: "private", first_name: "Fixture" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: text.length }],
    },
  }
}
it.each([
  { text: "/admin", status: "pending" },
  { text: "/admin@fixture_bot", status: "failed" },
])(
  "opens administration before chat approval with $text and $status policy",
  async ({ text, status }) => {
    const { telegram, store, sessions, calls } = await setup()
    if (status === "failed") store.applied(1, false)
    expect(store.allows(42)).toBe(false)
    await telegram.bot.handleUpdate(command(text))
    expect(calls).toEqual([
      {
        method: "sendMessage",
        payload: expect.objectContaining({
          chat_id: 42,
          reply_markup: {
            inline_keyboard: [[{ text: "Open administration", url: "https://admin.example.test" }]],
          },
        }),
      },
    ])
    expect(sessions.submit).not.toHaveBeenCalled()
    expect(sessions.appendPassiveContext).not.toHaveBeenCalled()
    expect(store.allows(42)).toBe(false)
  },
)
it.each(["other-user", "group", "anonymous-group", "mismatched-private"])(
  "does not expose the link to %s",
  async (kind) => {
    const { telegram, store, calls, sessions } = await setup()
    // Approve these chats to prove that bot access does not grant administrator access.
    const policy = store.snapshot().policy
    policy.privateUsers = [42, 43]
    policy.groups = [-100]
    store.save(policy, 1, "42")
    store.applied(2, true)
    const update = command("/admin", kind === "other-user" ? 43 : 42, kind.includes("group"))
    if (update.message && kind === "anonymous-group")
      update.message.sender_chat = { id: -100, type: "supergroup", title: "Fixture" }
    if (update.message && kind === "mismatched-private")
      update.message.chat = { id: 43, type: "private", first_name: "Fixture" }
    await telegram.bot.handleUpdate(update)
    expect(calls).toEqual([])
    expect(sessions.submit).not.toHaveBeenCalled()
    expect(sessions.appendPassiveContext).not.toHaveBeenCalled()
  },
)
it("tells the owner when the WebUI is disabled without starting a model turn", async () => {
  const { telegram, calls, sessions } = await setup(false)
  await telegram.bot.handleUpdate(command())
  expect(calls).toEqual([
    {
      method: "sendMessage",
      payload: expect.objectContaining({
        text: expect.stringContaining("Administration WebUI is not enabled"),
      }),
    },
  ])
  expect(calls[0]?.payload).not.toHaveProperty("reply_markup")
  expect(sessions.submit).not.toHaveBeenCalled()
})
it("does not authorize an owner when BOT_ADMIN_ID is missing", async () => {
  const { telegram, calls } = await setup(false, false)
  await telegram.bot.handleUpdate(command())
  expect(calls).toEqual([])
})
it("adds admin only to the owner's private command menu", async () => {
  const { telegram, calls } = await setup()
  await telegram.stop()
  await telegram.start()
  expect(calls).toHaveLength(2)
  expect(calls[0]?.method).toBe("setMyCommands")
  expect(calls[0]?.payload.commands).not.toContainEqual(
    expect.objectContaining({ command: "admin" }),
  )
  expect(calls[1]).toEqual({
    method: "setMyCommands",
    payload: expect.objectContaining({
      scope: { type: "chat", chat_id: 42 },
      commands: expect.arrayContaining([
        { command: "admin", description: "Open the administration WebUI" },
      ]),
    }),
  })
})
