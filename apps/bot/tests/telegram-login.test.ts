import type { AuthInteraction } from "@earendil-works/pi-ai"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { createOAuthLogin, type OAuthLoginClient } from "@narumitw/sumire-login"
import { Bot } from "grammy"
import type { Update, UserFromGetMe } from "grammy/types"
import { describe, expect, it, vi } from "vitest"

import type { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { loadSettings } from "../src/config/settings.js"
import type { Logger } from "../src/logging.js"
import { createTelegramAgentBot } from "../src/telegram/bot.js"
import { registerTelegramLogin } from "../src/telegram/login.js"

const botInfo = { id: 999, is_bot: true, first_name: "Test", username: "test_bot" } as UserFromGetMe
const callback =
  "http://127.0.0.1:1455/auth/callback?code=fixture-code&state=fixture-state&client_id=fixture-client"

function message(id: number, text: string, userId = 7, group = false): Update {
  const command = text.split(/\s/u)[0] ?? ""
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1_700_000_000,
      chat: group
        ? { id: -100, type: "group", title: "Group" }
        : { id: userId, type: "private", first_name: "User" },
      from: { id: userId, is_bot: false, first_name: "User" },
      text,
      ...(command.startsWith("/")
        ? { entities: [{ type: "bot_command", offset: 0, length: command.length }] }
        : {}),
    },
  }
}

function apiMock(bot: Bot, fail?: (method: string, payload: Record<string, unknown>) => boolean) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  bot.api.config.use(async (_previous, method, payload) => {
    const record = { method, payload: payload as Record<string, unknown> }
    calls.push(record)
    if (fail?.(method, record.payload)) throw new Error(`private-transport-body ${callback}`)
    return {
      ok: true,
      result:
        method === "sendMessage"
          ? {
              message_id: 100 + calls.length,
              date: 1_700_000_001,
              chat: { id: Number(record.payload.chat_id), type: "private", first_name: "User" },
              text: record.payload.text,
            }
          : true,
    } as never
  })
  return calls
}

function loginClient(timeoutMs = 300_000) {
  const inputs: string[] = []
  const runtime = {
    login: vi.fn<ModelRuntime["login"]>(async (_provider, _type, ui) => {
      ui.notify({ type: "auth_url", url: "https://auth.openai.com/test" })
      inputs.push(
        await ui.prompt({ type: "manual_code", message: "Paste callback", signal: ui.signal }),
      )
      return { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: 0 }
    }),
  }
  return { client: createOAuthLogin(runtime, { timeoutMs }), runtime, inputs }
}

function setup(
  options: {
    client?: OAuthLoginClient | null
    adminId?: string
    whitelist?: string
    fail?: Parameters<typeof apiMock>[1]
  } = {},
) {
  const settings = loadSettings({
    BOT_TOKEN: "1:test",
    BOT_WHITELIST: options.whitelist ?? "7,8,-100",
    BOT_ADMIN_ID: options.adminId ?? "7",
  })
  const bot = new Bot(settings.botToken, { botInfo })
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const fake = loginClient()
  const bridge = registerTelegramLogin(
    bot,
    settings,
    logger,
    options.client === null ? undefined : (options.client ?? fake.client),
  )
  const forwarded: string[] = []
  bot.on("message", (ctx) => {
    forwarded.push(ctx.message.text ?? "")
  })
  const calls = apiMock(bot, options.fail)
  return { bot, bridge, logger, calls, forwarded, ...fake }
}

async function waitForPrompt(calls: ReturnType<typeof apiMock>) {
  await vi.waitFor(() =>
    expect(calls.some((call) => String(call.payload.text).includes("再貼上完整"))).toBe(true),
  )
}

async function waitForResult(calls: ReturnType<typeof apiMock>, text: string) {
  await vi.waitFor(() =>
    expect(calls.some((call) => String(call.payload.text).includes(text))).toBe(true),
  )
}

describe("Telegram OAuth login", () => {
  it.each([
    ["non-admin", message(1, "/login", 8)],
    ["group", message(1, "/login", 7, true)],
    [
      "anonymous sender",
      {
        ...message(1, "/login"),
        message: {
          ...message(1, "/login").message,
          sender_chat: { id: -100, type: "group", title: "Group" },
        },
      } as Update,
    ],
    [
      "bot sender",
      {
        ...message(1, "/login"),
        message: {
          ...message(1, "/login").message,
          from: { id: 7, is_bot: true, first_name: "Bot" },
        },
      } as Update,
    ],
  ])("rejects %s without initiating OAuth", async (_name, update) => {
    const { bot, runtime, forwarded } = setup()
    await bot.handleUpdate(update)
    expect(runtime.login).not.toHaveBeenCalled()
    expect(forwarded).toEqual([])
  })

  it("rejects an unset admin without initiating OAuth", async () => {
    const { bot, runtime, forwarded } = setup({ adminId: "" })
    await bot.handleUpdate(message(1, "/login"))
    expect(runtime.login).not.toHaveBeenCalled()
    expect(forwarded).toEqual([])
  })

  it.each([
    {
      name: "admin missing from the explicit whitelist",
      options: { whitelist: "8,-100" },
      expected: ["執行中的 BOT_WHITELIST 未包含 BOT_ADMIN_ID", "群組 ID 不算"],
      unexpected: ["OPENAI_BASE_URL", "登入服務未啟用"],
    },
    {
      name: "eligible settings with no login client",
      options: {},
      expected: ["設定符合 /login 條件", "登入服務未啟用", "部署版本", "啟動紀錄"],
      unexpected: ["請使用官方", "明確加入白名單", "重新部署"],
    },
    {
      name: "eligible settings with duplicate IDs and whitespace",
      options: { whitelist: "7, -100,7" },
      expected: ["設定符合 /login 條件", "登入服務未啟用"],
      unexpected: ["自訂 OPENAI_BASE_URL", "明確加入白名單", "重新部署"],
    },
  ])("explains unavailable login: $name", async ({ options, expected, unexpected }) => {
    const { bot, runtime, forwarded, calls } = setup({ ...options, client: null })
    await bot.handleUpdate(message(1, "/login"))
    expect(runtime.login).not.toHaveBeenCalled()
    expect(forwarded).toEqual([])
    const replies = calls.filter((call) => call.method === "sendMessage")
    expect(replies).toHaveLength(1)
    const text = String(replies[0]?.payload.text)
    for (const value of expected) expect(text).toContain(value)
    for (const value of unexpected) expect(text).not.toContain(value)
    expect(text).not.toContain("proxy.example.test")
    expect(text).not.toContain("fixture-secret")
  })

  it("rejects secret command arguments without echoing them", async () => {
    const { bot, runtime, calls } = setup()
    await bot.handleUpdate(message(1, "/login fixture-secret"))
    expect(runtime.login).not.toHaveBeenCalled()
    expect(JSON.stringify(calls)).not.toContain("fixture-secret")
  })

  it("sends a browser button and consumes only the admin's private callback", async () => {
    const { bot, bridge, runtime, inputs, calls, forwarded, logger } = setup()
    await bot.handleUpdate(message(1, "/login@test_bot"))
    await waitForPrompt(calls)
    expect(calls.find((call) => call.payload.reply_markup)?.payload.reply_markup).toEqual({
      inline_keyboard: [[{ text: "Login to OpenAI", url: "https://auth.openai.com/test" }]],
    })
    await bot.handleUpdate(message(2, callback, 8))
    await bot.handleUpdate(message(3, callback, 7, true))
    expect(inputs).toEqual([])
    await bot.handleUpdate(message(4, callback))
    await waitForResult(calls, "已登入 OpenAI")
    expect(inputs).toEqual([callback])
    expect(runtime.login).toHaveBeenCalledTimes(1)
    expect(forwarded).toEqual([])
    expect(calls.filter((call) => call.method === "deleteMessage")).toHaveLength(3)
    expect(JSON.stringify(calls)).not.toContain("fixture-code")
    expect(JSON.stringify(logger)).not.toContain("fixture-code")
    await bridge.stop()
  })

  it("keeps invalid text/media and /ask out of model turns while waiting", async () => {
    const { bot, bridge, calls, forwarded, inputs } = setup()
    await bot.handleUpdate(message(1, "/login"))
    await waitForPrompt(calls)
    await bot.handleUpdate(message(2, "not a callback"))
    await bot.handleUpdate(message(3, `/ask ${callback}`))
    const media = message(4, "")
    if (media.message) {
      delete media.message.text
      media.message.photo = [{ file_id: "fixture", file_unique_id: "fixture", width: 1, height: 1 }]
    }
    await bot.handleUpdate(media)
    expect(inputs).toEqual([])
    expect(forwarded).toEqual([])
    await bridge.stop()
  })

  it("allows only one login and cancels it without blocking future login", async () => {
    const { bot, bridge, calls, runtime } = setup()
    await bot.handleUpdate(message(1, "/login"))
    await waitForPrompt(calls)
    await bot.handleUpdate(message(2, "/login"))
    expect(runtime.login).toHaveBeenCalledTimes(1)
    await bot.handleUpdate(message(3, "/cancel"))
    await waitForResult(calls, "已取消 OpenAI")
    await bot.handleUpdate(message(4, "/login"))
    await vi.waitFor(() => expect(runtime.login).toHaveBeenCalledTimes(2))
    await bridge.stop()
  })

  it("drops late callbacks, command arguments, and quoted callbacks after cancellation", async () => {
    const { bot, calls, forwarded } = setup()
    await bot.handleUpdate(message(1, "/login"))
    await waitForPrompt(calls)
    await bot.handleUpdate(message(2, "/cancel"))
    await bot.handleUpdate(message(3, callback))
    await bot.handleUpdate(message(4, `/ask ${callback}`))
    const quoted = message(5, "Summarize this")
    const source = message(3, callback).message
    if (quoted.message && source)
      quoted.message.reply_to_message = { ...source, reply_to_message: undefined }
    await bot.handleUpdate(quoted)
    expect(forwarded).toEqual([])
  })

  it("bounds login duration and accepts a new login after timeout", async () => {
    const fake = loginClient(20)
    const { bot, bridge, calls, forwarded } = setup({ client: fake.client })
    await bot.handleUpdate(message(1, "/login"))
    await waitForResult(calls, "登入已逾時")
    await bot.handleUpdate(message(2, callback))
    expect(forwarded).toEqual([])
    await bot.handleUpdate(message(3, "/login"))
    await vi.waitFor(() => expect(fake.runtime.login).toHaveBeenCalledTimes(2))
    await bridge.stop()
  })

  it("hides provider failures and cleans up for the next attempt", async () => {
    const client = {
      login: vi.fn(async (_ui: AuthInteraction) => {
        throw new Error(`fixture-access ${callback}`)
      }),
    }
    const { bot, bridge, calls, forwarded, logger } = setup({ client })
    await bot.handleUpdate(message(1, "/login"))
    await waitForResult(calls, "登入失敗")
    expect(JSON.stringify(calls)).not.toContain("fixture-code")
    expect(logger.warn).not.toHaveBeenCalled()
    await bot.handleUpdate(message(2, callback))
    expect(forwarded).toEqual([])
    await bridge.stop()
  })

  it("cancels login when Telegram delivery fails and never logs the transport body", async () => {
    const { bot, bridge, runtime, calls, logger } = setup({
      fail: (_method, payload) => Boolean(payload.reply_markup),
    })
    await bot.handleUpdate(message(1, "/login"))
    await waitForResult(calls, "登入失敗")
    const ui = runtime.login.mock.calls[0]?.[2]
    expect(ui?.signal?.aborted).toBe(true)
    expect(logger.warn).toHaveBeenCalledWith("OAuth login message delivery failed")
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("fixture-code")
    await bridge.stop()
  })

  it("finishes an automatic browser callback after dismissing pending manual input", async () => {
    const client: OAuthLoginClient = {
      login: async (ui) => {
        const promptController = new AbortController()
        const pending = ui.prompt({
          type: "manual_code",
          message: "Callback",
          signal: promptController.signal,
        })
        promptController.abort()
        await expect(pending).rejects.toThrow()
      },
    }
    const { bot, bridge, calls, forwarded } = setup({ client })
    await bot.handleUpdate(message(1, "/login"))
    await waitForResult(calls, "已登入 OpenAI")
    await bot.handleUpdate(message(2, callback))
    expect(forwarded).toEqual([])
    await bridge.stop()
  })

  it("consumes callbacks even if Telegram refuses to delete them", async () => {
    const { bot, bridge, calls, inputs, forwarded } = setup({
      fail: (method) => method === "deleteMessage",
    })
    await bot.handleUpdate(message(1, "/login"))
    await waitForPrompt(calls)
    await bot.handleUpdate(message(2, callback))
    await waitForResult(calls, "已登入 OpenAI")
    expect(inputs).toEqual([callback])
    expect(forwarded).toEqual([])
    await bridge.stop()
  })

  it("does not call OpenAI when the initial Telegram message fails", async () => {
    const { bot, bridge, calls, runtime } = setup({ fail: () => true })
    await bot.handleUpdate(message(1, "/login"))
    await waitForResult(calls, "登入失敗")
    expect(runtime.login).not.toHaveBeenCalled()
    await bridge.stop()
  })

  it("rejects unexpected secret prompts and non-OpenAI authorization links", async () => {
    for (const authenticate of [
      async (ui: AuthInteraction) => {
        await ui.prompt({ type: "secret", message: "fixture-secret-prompt" })
      },
      async (ui: AuthInteraction) => {
        ui.notify({ type: "auth_url", url: "https://untrusted.example.test/" })
      },
    ]) {
      const { bot, bridge, calls } = setup({ client: { login: authenticate } })
      await bot.handleUpdate(message(1, "/login"))
      await waitForResult(calls, "登入失敗")
      expect(JSON.stringify(calls)).not.toContain("fixture-secret-prompt")
      expect(JSON.stringify(calls)).not.toContain("untrusted.example.test")
      await bridge.stop()
    }
  })

  it("cancels on shutdown without sending a final notification", async () => {
    const { bot, bridge, calls, runtime } = setup()
    await bot.handleUpdate(message(1, "/login"))
    await waitForPrompt(calls)
    const count = calls.length
    await bridge.stop()
    expect(runtime.login.mock.calls[0]?.[2].signal?.aborted).toBe(true)
    expect(calls).toHaveLength(count)
  })

  it.each([true, false])(
    "shows /login in help only when login is available: %s",
    async (enabled) => {
      const settings = loadSettings({
        BOT_TOKEN: "1:test",
        BOT_WHITELIST: "7",
        BOT_ADMIN_ID: "7",
      })
      const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
      const app = createTelegramAgentBot(settings, {} as ChatSessionRegistry, logger, {
        botInfo,
        ...(enabled ? { login: loginClient().client } : {}),
      })
      const calls = apiMock(app.bot)
      await app.bot.handleUpdate(message(1, "/help"))
      expect(calls.some((call) => String(call.payload.text).includes("/login"))).toBe(enabled)
      await app.stop()
    },
  )

  it("is wired before ordinary bot submissions and never uses Morsel", async () => {
    const settings = loadSettings({
      BOT_TOKEN: "1:test",
      BOT_WHITELIST: "7",
      BOT_ADMIN_ID: "7",
    })
    const submit = vi.fn()
    const appendPassiveContext = vi.fn()
    const sessions = { submit, appendPassiveContext } as unknown as ChatSessionRegistry
    const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const fake = loginClient()
    const publish = vi.fn()
    const app = createTelegramAgentBot(settings, sessions, logger, {
      botInfo,
      login: fake.client,
      morselPublisher: { isConfigured: true, publish },
    })
    const calls = apiMock(app.bot)
    await app.bot.handleUpdate(message(1, "/login"))
    await waitForPrompt(calls)
    await app.bot.handleUpdate(message(2, callback))
    await waitForResult(calls, "已登入 OpenAI")
    expect(submit).not.toHaveBeenCalled()
    expect(appendPassiveContext).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    await app.stop()
  })
})
