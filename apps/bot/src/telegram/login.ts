import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai"
import { type OAuthLoginClient, OAuthLoginError } from "@narumitw/sumire-login"
import type { Bot, Context } from "grammy"
import type { InlineKeyboardMarkup } from "grammy/types"

import type { Settings } from "../config/settings.js"
import type { Logger } from "../logging.js"

interface PendingInput {
  resolve(value: string): void
  cancel(): void
}

interface LoginState {
  chatId: number
  userId: number
  controller: AbortController
  delivery: Promise<void>
  done: Promise<void>
  pending?: PendingInput
  deliveryFailed: boolean
}

const callbackHint = "http://127.0.0.1:1455/auth/callback"
const inputHint = `請在瀏覽器完成 OpenAI 登入，再貼上完整的 ${callbackHint} 授權回覆網址。若瀏覽器顯示無法連線，仍可複製網址列。請勿傳送 API key 或 token；使用 /cancel 取消。`

/** Register before ordinary command/input handlers. OAuth never goes through a model turn. */
export function registerTelegramLogin(
  bot: Bot,
  settings: Settings,
  logger: Logger,
  login?: OAuthLoginClient,
): { stop(): Promise<void> } {
  let active: LoginState | undefined
  let stopping = false

  const isAdmin = (context: Context) =>
    settings.botAdminId !== undefined &&
    context.from?.id === settings.botAdminId &&
    context.from.is_bot === false &&
    context.message?.sender_chat === undefined &&
    context.chat?.type === "private"

  bot.use(async (context, next) => {
    const message = context.message
    if (!message) return next()
    const state = active
    const ownsLogin =
      state &&
      isAdmin(context) &&
      context.from?.id === state.userId &&
      context.chat?.id === state.chatId
    const text = message.text?.trim() ?? ""
    const command = message.entities?.find(
      (entity) => entity.type === "bot_command" && entity.offset === 0,
    )
    const commandName = command ? text.slice(1, command.length).split("@")[0] : undefined
    const hasCallback = [
      text,
      message.caption,
      message.reply_to_message?.text,
      message.reply_to_message?.caption,
    ].some((value) => value && containsCallback(value))

    if (ownsLogin && commandName === "cancel") {
      state.controller.abort()
      await state.done
      return
    }
    if (ownsLogin && commandName !== "login") {
      if (hasCallback) await deleteCallback(context)
      if (!command && isCallback(text) && state.pending) {
        state.pending.resolve(text)
      } else {
        await safeReply(context, state.pending ? inputHint : "登入處理中，請稍候或使用 /cancel。")
      }
      return
    }
    // Drop callbacks even after cancellation/timeout/restart, in groups, or inside /ask/replies.
    if (hasCallback) {
      await deleteCallback(context)
      await safeReply(context, "授權回覆未送給模型。請管理員在私聊使用 /login 重新登入。")
      return
    }
    await next()
  })

  bot.command("login", async (context) => {
    if (!isAdmin(context) || !context.from) {
      await safeReply(context, "只有 BOT_ADMIN_ID 可以在與 bot 的私聊中使用 /login。")
      return
    }
    if (!login) {
      const reasons: string[] = []
      if (!settings.botWhitelist.has(context.from.id)) {
        reasons.push(
          "執行中的 BOT_WHITELIST 未包含 BOT_ADMIN_ID 的使用者 ID；群組 ID 不算，請將該使用者 ID 明確加入白名單。",
        )
      }
      await safeReply(
        context,
        reasons.length > 0
          ? `/login 尚未啟用：\n${reasons.map((reason) => `• ${reason}`).join("\n")}\n\n修改設定後，請重新部署 bot，讓新設定生效。`
          : "執行中的設定符合 /login 條件，但登入服務未啟用。請檢查部署版本及啟動紀錄。",
      )
      return
    }
    if (context.match.trim()) {
      await safeReply(context, "請使用 /login，不要附加 API key、token 或授權網址。")
      return
    }
    if (active) {
      await safeReply(context, "已有登入流程進行中，請完成登入或使用 /cancel。")
      return
    }
    if (stopping) return
    const state: LoginState = {
      chatId: context.chat.id,
      userId: context.from.id,
      controller: new AbortController(),
      delivery: Promise.resolve(),
      done: Promise.resolve(),
      deliveryFailed: false,
    }
    active = state
    enqueue(state, "正在建立 OpenAI 登入流程。登入後，所有允許使用 bot 的使用者將共用此帳號。")
    state.done = run(state, login)
    // Do not hold the polling handler while waiting for a later Telegram update.
    await state.delivery
  })

  function enqueue(state: LoginState, text: string, keyboard?: InlineKeyboardMarkup): void {
    state.delivery = state.delivery
      .then(async () => {
        if (stopping || state.controller.signal.aborted) return
        await bot.api.sendMessage(
          state.chatId,
          text,
          {
            link_preview_options: { is_disabled: true },
            ...(keyboard ? { reply_markup: keyboard } : {}),
          },
          telegramSignal(AbortSignal.any([state.controller.signal, AbortSignal.timeout(30_000)])),
        )
      })
      .catch(() => {
        state.deliveryFailed = true
        state.controller.abort()
        logger.warn("OAuth login message delivery failed")
      })
  }

  function notify(state: LoginState, event: AuthEvent): void {
    if (event.type === "auth_url") {
      const url = new URL(event.url)
      if (
        url.protocol !== "https:" ||
        url.hostname !== "auth.openai.com" ||
        url.username ||
        url.password
      ) {
        throw new OAuthLoginError("failed")
      }
      enqueue(state, "請在瀏覽器登入 OpenAI：", {
        inline_keyboard: [[{ text: "Login to OpenAI", url: event.url }]],
      })
    }
  }

  function prompt(state: LoginState, request: AuthPrompt): Promise<string> {
    if (request.type !== "manual_code" || state.pending) {
      return Promise.reject(new OAuthLoginError("failed"))
    }
    const signal = request.signal
      ? AbortSignal.any([request.signal, state.controller.signal])
      : state.controller.signal
    return new Promise((resolve, reject) => {
      const finish = (value?: string) => {
        signal.removeEventListener("abort", cancel)
        if (state.pending === pending) state.pending = undefined
        if (value === undefined) reject(new OAuthLoginError("cancelled"))
        else resolve(value)
      }
      const cancel = () => finish()
      const pending: PendingInput = { resolve: (value) => finish(value), cancel }
      state.pending = pending
      signal.addEventListener("abort", cancel, { once: true })
      if (signal.aborted) cancel()
      else enqueue(state, inputHint)
    })
  }

  async function run(state: LoginState, client: OAuthLoginClient): Promise<void> {
    let result = "OpenAI 登入失敗，請使用 /login 重試。"
    try {
      await state.delivery
      state.controller.signal.throwIfAborted()
      await client.login({
        signal: state.controller.signal,
        notify: (event) => notify(state, event),
        prompt: (request) => prompt(state, request),
      })
      await state.delivery
      if (!state.deliveryFailed) result = "已登入 OpenAI。所有 bot 對話現在共用此帳號。"
    } catch (error) {
      if (!state.deliveryFailed) {
        if (state.controller.signal.aborted) result = "已取消 OpenAI 登入。"
        else if (error instanceof OAuthLoginError && error.kind === "timeout") {
          result = "OpenAI 登入已逾時，請使用 /login 重試。"
        }
      }
      // Deliberately do not log provider errors or authentication input.
    } finally {
      state.pending?.cancel()
      await state.delivery
      if (!stopping) await safeSend(state.chatId, result)
      if (active === state) active = undefined
    }
  }

  async function safeSend(chatId: number, text: string): Promise<void> {
    try {
      // Login content must never be published to Morsel or quote authorization input.
      await bot.api.sendMessage(
        chatId,
        text,
        { link_preview_options: { is_disabled: true } },
        telegramSignal(AbortSignal.timeout(30_000)),
      )
    } catch {
      logger.warn("OAuth login message delivery failed")
    }
  }

  async function safeReply(context: Context, text: string): Promise<void> {
    if (context.chat) await safeSend(context.chat.id, text)
  }

  async function deleteCallback(context: Context): Promise<void> {
    try {
      await context.deleteMessage(telegramSignal(AbortSignal.timeout(30_000)))
    } catch {
      // Telegram may deny deletion; do not retain or log the callback.
    }
  }

  return {
    async stop() {
      stopping = true
      const state = active
      state?.controller.abort()
      await state?.done
    },
  }
}

function telegramSignal(
  signal: AbortSignal,
): NonNullable<Parameters<Bot["api"]["sendMessage"]>[3]> {
  // grammY accepts native signals at runtime but its Node declarations use abort-controller.
  return signal as unknown as NonNullable<Parameters<Bot["api"]["sendMessage"]>[3]>
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

function containsCallback(text: string): boolean {
  return text.split(/\s+/u).some(isCallback)
}
