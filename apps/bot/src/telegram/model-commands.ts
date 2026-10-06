import { createHash } from "node:crypto"

import { type Bot, type Context, InlineKeyboard } from "grammy"

import { type ChatModelState, ModelSettingsError } from "../agent/model-settings.js"
import type { ChatSessionRegistry } from "../agent/session-registry.js"
import type { Logger } from "../logging.js"

const modelsPerPage = 8

/** Short stable references keep callback data below Telegram's 64-byte limit. */
function modelToken(reference: string): string {
  return createHash("sha256").update(reference).digest("base64url").slice(0, 22)
}

function currentSettings(settings: ChatModelState): string {
  return `Model：${(settings.currentModel ?? "未設定").slice(0, 160)}\nThinking：${settings.thinkingLevel}`
}

export function registerTelegramModelCommands(
  bot: Bot,
  sessions: ChatSessionRegistry,
  logger: Logger,
): void {
  async function handle(context: Context, action: (chatId: number) => Promise<void>) {
    const chatId = context.chat?.id
    if (chatId === undefined) return
    try {
      await action(chatId)
    } catch (error) {
      if (!(error instanceof ModelSettingsError)) {
        logger.warn(`Telegram model settings failed for chat_id=${chatId}`, error)
      }
      await context.reply(
        error instanceof ModelSettingsError
          ? error.message
          : "無法讀取或切換設定，請確認已設定驗證並稍後再試。",
      )
    }
  }

  async function showModels(context: Context, chatId: number, requestedPage = 0) {
    const settings = await sessions.getModelSettings(chatId)
    if (settings.models.length === 0) {
      throw new ModelSettingsError(
        "目前沒有已驗證的 model，請先設定 API key 或請管理員使用 /login。",
      )
    }
    const pages = Math.ceil(settings.models.length / modelsPerPage)
    const page = Math.max(0, Math.min(pages - 1, requestedPage))
    const keyboard = new InlineKeyboard()
    for (const reference of settings.models.slice(
      page * modelsPerPage,
      (page + 1) * modelsPerPage,
    )) {
      keyboard
        .text(
          `${reference === settings.currentModel ? "✓ " : ""}${reference.slice(0, 80)}`,
          `model:select:${modelToken(reference)}`,
        )
        .row()
    }
    if (page > 0) keyboard.text("上一頁", `model:page:${page - 1}`)
    if (page + 1 < pages) keyboard.text("下一頁", `model:page:${page + 1}`)
    const text = `${currentSettings(settings)}\n\n請選擇這個 chat 的 model（${page + 1}/${pages}）。\n也可使用 /model <provider/model>。`
    if (context.callbackQuery) await context.editMessageText(text, { reply_markup: keyboard })
    else await context.reply(text, { reply_markup: keyboard })
  }

  bot.command("model", (context) =>
    handle(context, async (chatId) => {
      const reference = context.match.trim()
      if (!reference) return showModels(context, chatId)
      const settings = await sessions.setModel(chatId, reference)
      await context.reply(`已更新這個 chat 的設定。\n${currentSettings(settings)}`)
    }),
  )

  bot.command("thinking", (context) =>
    handle(context, async (chatId) => {
      const level = context.match.trim()
      if (level) {
        const settings = await sessions.setThinkingLevel(chatId, level)
        await context.reply(`已更新這個 chat 的設定。\n${currentSettings(settings)}`)
        return
      }
      const settings = await sessions.getModelSettings(chatId)
      const keyboard = new InlineKeyboard()
      for (const supported of settings.thinkingLevels) {
        keyboard
          .text(
            `${supported === settings.thinkingLevel ? "✓ " : ""}${supported}`,
            `thinking:select:${supported}`,
          )
          .row()
      }
      await context.reply(
        `${currentSettings(settings)}\n\n${settings.thinkingLevels.length === 1 && settings.thinkingLevels[0] === "off" ? "目前 model 不支援 thinking，僅可使用 off。" : "請選擇這個 chat 的 thinking level。"}\n也可使用 /thinking <level>。`,
        { reply_markup: keyboard },
      )
    }),
  )

  bot.callbackQuery(/^model:page:(\d{1,6})$/u, async (context) => {
    await context.answerCallbackQuery()
    await handle(context, (chatId) => showModels(context, chatId, Number(context.match[1])))
  })

  bot.callbackQuery(/^model:select:([A-Za-z0-9_-]{22})$/u, async (context) => {
    await context.answerCallbackQuery()
    await handle(context, async (chatId) => {
      const options = await sessions.getModelSettings(chatId)
      const reference = options.models.find(
        (reference) => modelToken(reference) === context.match[1],
      )
      if (!reference)
        throw new ModelSettingsError("這個 model 已無法使用，請重新使用 /model 選擇。")
      const settings = await sessions.setModel(chatId, reference)
      await context.editMessageText(`已更新這個 chat 的設定。\n${currentSettings(settings)}`, {
        reply_markup: { inline_keyboard: [] },
      })
    })
  })

  bot.callbackQuery(/^thinking:select:([a-z]+)$/u, async (context) => {
    await context.answerCallbackQuery()
    await handle(context, async (chatId) => {
      const settings = await sessions.setThinkingLevel(chatId, context.match[1] ?? "")
      await context.editMessageText(`已更新這個 chat 的設定。\n${currentSettings(settings)}`, {
        reply_markup: { inline_keyboard: [] },
      })
    })
  })
}
