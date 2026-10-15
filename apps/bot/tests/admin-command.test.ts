import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Update, UserFromGetMe } from "grammy/types"
import { afterEach, expect, it, vi } from "vitest"
import { createPasskeySetup, PasskeyAdminLogin } from "../src/admin/auth.js"
import { AdminStore } from "../src/admin/store.js"
import type { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { loadSettings } from "../src/config/settings.js"
import { createTelegramAgentBot } from "../src/telegram/bot.js"
import { createPasskeyFixture } from "./helpers/passkey-fixture.js"

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
            inline_keyboard: [
              [
                {
                  text: "Register passkey",
                  url: expect.stringMatching(
                    /^https:\/\/admin\.example\.test\/#setup=[A-Za-z0-9_-]{43}$/,
                  ),
                },
              ],
            ],
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
    expect(store.db.prepare("SELECT * FROM passkey_setup").all()).toEqual([])
    expect(sessions.submit).not.toHaveBeenCalled()
    expect(sessions.appendPassiveContext).not.toHaveBeenCalled()
  },
)
it("returns only the ordinary WebUI link after passkey registration", async () => {
  const { telegram, store, calls } = await setup()
  const origin = "https://admin.example.test"
  const link = createPasskeySetup(store, origin) as string
  const secret = new URLSearchParams(new URL(link).hash.slice(1)).get("setup") as string
  const login = new PasskeyAdminLogin({ origin, host: "127.0.0.1", port: 0, assets: "" }, store)
  const start = await login.beginRegistration(secret)
  await login.finishRegistration(
    start.browser,
    createPasskeyFixture().registration(start.options.challenge),
  )
  await telegram.bot.handleUpdate(command())
  expect(calls[0]?.payload).toMatchObject({
    reply_markup: { inline_keyboard: [[{ text: "Open administration", url: origin }]] },
  })
  expect(store.db.prepare("SELECT * FROM passkey_setup").all()).toEqual([])
})
it("sends a local setup URL when ADMIN_ORIGIN is missing without starting a model turn", async () => {
  const { telegram, calls, sessions } = await setup(false)
  await telegram.bot.handleUpdate(command())
  expect(calls).toEqual([
    {
      method: "sendMessage",
      payload: expect.objectContaining({
        text: expect.stringMatching(/http:\/\/localhost:17465\/#setup=[A-Za-z0-9_-]{43}/),
        link_preview_options: { is_disabled: true },
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
