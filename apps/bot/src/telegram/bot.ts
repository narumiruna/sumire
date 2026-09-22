import type { RunnerHandle } from "@grammyjs/runner"
import { Bot, type Context, GrammyError, HttpError } from "grammy"
import type { UserFromGetMe } from "grammy/types"

import type { ChatSessionRegistry } from "../agent/session-registry.js"
import type { Settings } from "../config/settings.js"
import { DocumentConversionError, type DocumentConverter } from "../documents/converter.js"
import { promptWithDocumentContext } from "../documents/prompt.js"
import type { Logger } from "../logging.js"
import { MarketDataInputError, queryMarketData } from "../market-data/query.js"
import { createMorselPublisher, type MorselPublisher } from "../morsel.js"
import { createTelegramDelivery } from "./delivery.js"
import {
  downloadTelegramFile,
  downloadTelegramImage,
  TelegramDownloadTooLargeError,
} from "./files.js"
import {
  defaultImagePrompt,
  documentReferences,
  imageReferences,
  isBotAddressed,
  messageText,
  passiveGroupContext,
  promptWithReplyContext,
  repliedBotMessageId,
  stripBotMention,
  type TelegramMessageLike,
} from "./messages.js"
import { runTelegramPolling } from "./polling.js"
import { createProgressStatusEditor, renderProgressStatus } from "./progress.js"

export interface TelegramAgentBot {
  bot: Bot
  start(): Promise<void>
  stop(): Promise<void>
}

interface TelegramBotDependencies {
  botInfo?: UserFromGetMe
  imageFetchImplementation?: typeof fetch
  documentConverter?: DocumentConverter
  marketDataQuery?: (input: string) => Promise<string>
  morselPublisher?: Pick<MorselPublisher, "isConfigured" | "publish">
}

export function createTelegramAgentBot(
  settings: Settings,
  sessions: ChatSessionRegistry,
  logger: Logger,
  dependencies: TelegramBotDependencies = {},
): TelegramAgentBot {
  const bot = new Bot(
    settings.botToken,
    dependencies.botInfo ? { botInfo: dependencies.botInfo } : {},
  )
  const botReplyStreaks = new Map<number, number>()
  const submissionTails = new Map<number, Promise<void>>()
  const submissionGenerations = new Map<
    number,
    { generation: number; reason: "reset" | "cancel" }
  >()
  let runner: RunnerHandle | undefined
  const morselPublisher = dependencies.morselPublisher ?? createMorselPublisher(settings)
  const delivery = createTelegramDelivery(
    morselPublisher,
    logger,
    settings.morselLongReplyThreshold,
  )
  const marketDataQuery =
    dependencies.marketDataQuery ??
    ((input: string) =>
      queryMarketData(input, {
        onError: (provider, error) => logger.warn(`${provider} market-data query failed`, error),
      }))

  bot.use(async (context, next) => {
    if (!isAllowed(context, settings.botWhitelist)) return
    await next()
  })

  bot.command("start", async (context) => {
    await delivery.reply(
      context,
      "你好！我是由 Pi agent 驅動的 Telegram AI 助理。使用 /help 查看可用指令。",
    )
  })
  bot.command("help", async (context) => {
    await delivery.reply(
      context,
      [
        "/ask <問題> — 詢問 AI 助理",
        "/t <代碼> — 查詢股票、虛擬貨幣或匯率（例如 AAPL、2330、BTCUSDT、TWDJPY）",
        "/reset — 清除目前 chat 的 Pi session",
        "/cancel — 取消目前任務與待處理輸入，並清除 steering/follow-up queue",
        "/id — 顯示 chat ID 與 user ID",
        ...(settings.botDocumentInputEnabled
          ? ["可附加 Word、PowerPoint、試算表、OpenDocument、RTF、EPUB、CSV 或文字型 PDF。"]
          : []),
        ...(settings.botReplyTreeEnabled ? ["回覆較早的 bot 回覆可從該對話分支繼續。"] : []),
        ...(settings.botCodingToolsEnabled
          ? ["可請助理使用 read、bash、edit、write 處理執行環境中的檔案與指令。"]
          : []),
        "可請助理使用 load_public_url 工具讀取公開網址。",
      ].join("\n"),
    )
  })
  bot.command("id", async (context) => {
    await delivery.reply(
      context,
      `chat_id=${context.chat.id}\nuser_id=${context.from?.id ?? "unknown"}`,
    )
  })
  bot.command("reset", async (context) => {
    const finishReset = invalidateSubmissionOrder(context.chat.id)
    try {
      await sessions.reset(context.chat.id)
    } finally {
      finishReset()
    }
    await delivery.reply(context, "已清除這個對話的 Pi session。", replyOptions(context))
  })
  bot.command("cancel", async (context) => {
    const pending = submissionTails.has(context.chat.id)
    const finishCancel = pending ? invalidateSubmissionOrder(context.chat.id, "cancel") : undefined
    let cancelled: boolean
    try {
      cancelled = await sessions.cancel(context.chat.id)
    } finally {
      finishCancel?.()
    }
    await delivery.reply(
      context,
      cancelled || pending ? "已取消目前任務。" : "目前沒有執行中的任務。",
      replyOptions(context),
    )
  })
  bot.command("ask", async (context) => {
    const prompt = context.match.trim()
    if (!prompt) {
      await delivery.reply(context, "請使用 /ask <問題>。", replyOptions(context))
      return
    }
    await inSubmissionOrder(context.chat.id, (release, isCurrent) =>
      submitInput(
        context,
        context.message as unknown as TelegramMessageLike,
        prompt,
        release,
        isCurrent,
      ),
    )
  })
  bot.command("t", async (context) => {
    const query = context.match.trim()
    if (!query) {
      await delivery.reply(
        context,
        "請使用 /t <代碼>，例如 /t AAPL、/t 2330、/t BTCUSDT 或 /t TWDJPY。",
        replyOptions(context),
      )
      return
    }
    try {
      const result = await marketDataQuery(query)
      await delivery.reply(
        context,
        result || `查不到 ${query} 的市場資料，請確認代碼或稍後再試。`,
        {
          ...replyOptions(context),
          parse_mode: "HTML",
        },
      )
    } catch (error) {
      if (error instanceof MarketDataInputError) {
        await delivery.reply(context, error.message, replyOptions(context))
        return
      }
      logger.warn(`Market-data command failed for chat_id=${context.chat.id}`, error)
      await delivery.reply(context, "市場資料服務暫時無法使用，請稍後再試。", replyOptions(context))
    }
  })

  bot.on("message", async (context) => {
    const message = context.message as unknown as TelegramMessageLike
    const chatType = context.chat.type
    const privateChat = chatType === "private"
    const fromBot = context.from?.is_bot === true

    if (fromBot) {
      const streak = botReplyStreaks.get(context.chat.id) ?? 0
      if (
        settings.botMaxConsecutiveRepliesToBots === 0 ||
        streak >= settings.botMaxConsecutiveRepliesToBots
      )
        return
    } else {
      botReplyStreaks.delete(context.chat.id)
    }

    const addressed = privateChat || isBotAddressed(message, context.me.id, context.me.username)
    if (!addressed) {
      if (settings.botGroupPassiveContextEnabled) {
        await inSubmissionOrder(context.chat.id, async () => {
          await sessions.appendPassiveContext(context.chat.id, passiveGroupContext(message))
        })
      }
      return
    }

    if (fromBot)
      botReplyStreaks.set(context.chat.id, (botReplyStreaks.get(context.chat.id) ?? 0) + 1)
    await inSubmissionOrder(context.chat.id, (release, isCurrent) =>
      submitInput(
        context,
        message,
        privateChat
          ? messageText(message).trim()
          : stripBotMention(messageText(message), context.me.username),
        release,
        isCurrent,
      ),
    )
  })

  async function submitInput(
    context: Context,
    message: TelegramMessageLike,
    strippedText: string,
    release: () => void,
    isCurrent: () => boolean,
  ): Promise<void> {
    const imageRefs = imageReferences(message)
    const documentRefs = documentReferences(message)
    if (imageRefs.length > 0 && !settings.botImageInputEnabled) {
      await delivery.reply(context, "目前未啟用圖片輸入。", replyOptions(context))
      return
    }
    if (documentRefs.length > 0 && !settings.botDocumentInputEnabled) {
      await delivery.reply(context, "目前未啟用文件輸入。", replyOptions(context))
      return
    }
    if (documentRefs.length > 0 && !dependencies.documentConverter) {
      await delivery.reply(context, "文件轉換服務目前無法使用。", replyOptions(context))
      return
    }

    let images: Array<{ type: "image"; data: string; mimeType: string }>
    try {
      images = await Promise.all(
        imageRefs.map((reference) =>
          downloadTelegramImage(
            context.api,
            settings.botToken,
            reference,
            settings.botImageMaxBytes,
            dependencies.imageFetchImplementation,
          ),
        ),
      )
    } catch (error) {
      if (!isCurrent()) return
      const response =
        error instanceof TelegramDownloadTooLargeError
          ? "圖片超過允許的大小，無法處理。"
          : "無法下載 Telegram 圖片，請稍後再試。"
      logger.warn(`Telegram image input failed for chat_id=${context.chat?.id}`, error)
      await delivery.reply(context, response, replyOptions(context))
      return
    }

    if (!isCurrent()) return
    let documentInputs: Array<{
      reference: (typeof documentRefs)[number]
      converted: Awaited<ReturnType<DocumentConverter["convert"]>>
    }> = []
    try {
      documentInputs = await Promise.all(
        documentRefs.map(async (reference) => {
          const converted = await dependencies.documentConverter?.convert(async () => {
            if (!isCurrent()) throw new Error("Telegram document input was invalidated")
            const bytes = await downloadTelegramFile(
              context.api,
              settings.botToken,
              reference,
              settings.botDocumentMaxBytes,
              dependencies.imageFetchImplementation,
            )
            if (!isCurrent()) throw new Error("Telegram document input was invalidated")
            return bytes
          }, reference.filename)
          if (!converted) throw new Error("Document converter is unavailable")
          return { reference, converted }
        }),
      )
    } catch (error) {
      if (!isCurrent()) return
      const response = documentFailureMessage(error)
      logger.warn(`Telegram document input failed for chat_id=${context.chat?.id}`, error)
      await delivery.reply(context, response, replyOptions(context))
      return
    }

    if (!isCurrent()) return
    let prompt: string
    if (documentInputs.length > 0) {
      prompt = promptWithReplyContext(
        message,
        promptWithDocumentContext(
          strippedText,
          documentInputs,
          settings.botDocumentMaxMarkdownChars,
        ),
      )
    } else {
      const basePrompt =
        strippedText || (images.length > 0 ? defaultImagePrompt : "請回應這則訊息。")
      prompt = promptWithReplyContext(message, basePrompt)
    }
    await answer(
      context,
      prompt,
      images,
      release,
      isCurrent,
      repliedBotMessageId(message, context.me.id),
    )
  }

  bot.catch((error) => {
    const context = error.ctx
    const cause = error.error
    if (cause instanceof GrammyError) {
      logger.error(
        `Telegram API error while handling update_id=${context.update.update_id}: ${cause.description}`,
      )
    } else if (cause instanceof HttpError) {
      logger.error(
        `Telegram transport error while handling update_id=${context.update.update_id}`,
        cause,
      )
    } else {
      logger.error(
        `Unhandled bot error while handling update_id=${context.update.update_id}`,
        cause,
      )
    }
  })

  async function answer(
    context: Context,
    prompt: string,
    images: Array<{ type: "image"; data: string; mimeType: string }>,
    releaseSubmissionTurn: () => void,
    isCurrent: () => boolean,
    replyToBotMessageId?: number,
  ): Promise<void> {
    if (!isCurrent()) return
    const chatId = context.chat?.id
    if (chatId === undefined) return
    const sourceMessageId = context.message?.message_id
    const replyOptions = {
      parse_mode: "HTML" as const,
      ...(sourceMessageId
        ? {
            reply_parameters: {
              message_id: sourceMessageId,
              allow_sending_without_reply: true,
            },
          }
        : {}),
    }
    let status: Awaited<ReturnType<typeof delivery.reply>> | undefined
    let hasProgressSnapshot = false
    const progressStatus = createProgressStatusEditor(
      async (text) => {
        if (status) {
          await delivery.edit(context, status.chat.id, status.message_id, text, isCurrent)
          return
        }
        const progressReply = await delivery.guardedReply(context, text, replyOptions, isCurrent)
        status = progressReply.message
      },
      (error) => logger.warn(`Telegram progress update failed for chat_id=${chatId}`, error),
    )
    const cancelStatus = async () => {
      await progressStatus.close()
      const text =
        submissionGenerations.get(chatId)?.reason === "cancel"
          ? "此請求已取消。"
          : "此請求已因重設對話而取消。"
      if (status) {
        await delivery.edit(context, status.chat.id, status.message_id, text)
      } else {
        status = await delivery.reply(context, text, replyOptions)
      }
    }
    if (!isCurrent()) {
      await cancelStatus()
      return
    }
    try {
      const unresolvedReplyPrompt =
        replyToBotMessageId !== undefined && context.message
          ? promptWithReplyContext(context.message as unknown as TelegramMessageLike, prompt, true)
          : undefined
      const result = await sessions.submit(chatId, prompt, {
        images,
        ...(replyToBotMessageId !== undefined ? { replyToBotMessageId } : {}),
        ...(unresolvedReplyPrompt ? { unresolvedReplyPrompt } : {}),
        onAccepted: releaseSubmissionTurn,
        isCurrent,
        onProgress: (steps) => {
          if (steps.length === 0 && !hasProgressSnapshot) return
          if (steps.length > 0) hasProgressSnapshot = true
          progressStatus.publish(renderProgressStatus(steps))
        },
      })
      if (!isCurrent()) {
        await cancelStatus()
        return
      }
      await progressStatus.close()
      let deliveryResult: "delivered" | "unavailable" | "stale"
      if (status) {
        deliveryResult = await delivery.edit(
          context,
          status.chat.id,
          status.message_id,
          result.text,
          isCurrent,
        )
      } else {
        const finalReply = await delivery.guardedReply(
          context,
          result.text,
          replyOptions,
          isCurrent,
        )
        status = finalReply.message
        deliveryResult = finalReply.result
      }
      if (deliveryResult === "stale") {
        await cancelStatus()
        return
      }
      if (deliveryResult === "delivered" && status) {
        await sessions.recordDelivery(
          chatId,
          result.kind === "completed" ? result.checkpoint : undefined,
          [status.message_id],
        )
      }
    } catch (error) {
      if (!isCurrent()) {
        await cancelStatus()
        return
      }
      logger.error(`Pi agent request failed for chat_id=${chatId}`, error)
      await progressStatus.close()
      if (status) {
        if (
          (await delivery.edit(
            context,
            status.chat.id,
            status.message_id,
            "AI 服務暫時無法使用，請稍後再試。",
            isCurrent,
          )) === "stale"
        ) {
          await cancelStatus()
        }
      } else {
        const errorReply = await delivery.guardedReply(
          context,
          "AI 服務暫時無法使用，請稍後再試。",
          replyOptions,
          isCurrent,
        )
        status = errorReply.message
        if (errorReply.result === "stale") await cancelStatus()
      }
    }
  }

  async function inSubmissionOrder(
    chatId: number,
    task: (release: () => void, isCurrent: () => boolean) => Promise<void>,
  ): Promise<void> {
    const generation = submissionGenerations.get(chatId)?.generation ?? 0
    const previous = submissionTails.get(chatId) ?? Promise.resolve()
    const { gate, release } = submissionGate(chatId, previous)
    submissionTails.set(chatId, gate)
    await previous

    try {
      if (isCurrent()) await task(release, isCurrent)
    } finally {
      release()
    }

    function isCurrent(): boolean {
      return (submissionGenerations.get(chatId)?.generation ?? 0) === generation
    }
  }

  function invalidateSubmissionOrder(
    chatId: number,
    reason: "reset" | "cancel" = "reset",
  ): () => void {
    submissionGenerations.set(chatId, {
      generation: (submissionGenerations.get(chatId)?.generation ?? 0) + 1,
      reason,
    })
    const { gate, release } = submissionGate(chatId, Promise.resolve())
    submissionTails.set(chatId, gate)
    return release
  }

  function submissionGate(
    chatId: number,
    previous: Promise<void>,
  ): { gate: Promise<void>; release: () => void } {
    let openGate = () => {}
    const next = new Promise<void>((resolve) => {
      openGate = resolve
    })
    const gate = previous.then(() => next)
    let released = false
    return {
      gate,
      release() {
        if (released) return
        released = true
        openGate()
        if (submissionTails.get(chatId) === gate) submissionTails.delete(chatId)
      },
    }
  }

  return {
    bot,
    async start() {
      await bot.init()
      logger.info(`Telegram bot started as @${bot.botInfo.username}`)
      runner = runTelegramPolling(bot, logger)
      await runner.task()
    },
    async stop() {
      if (!runner) return
      await runner.stop()
      runner = undefined
    },
  }
}

function documentFailureMessage(error: unknown): string {
  if (error instanceof TelegramDownloadTooLargeError) return "文件超過允許的大小，無法處理。"
  if (!(error instanceof DocumentConversionError)) return "無法下載或轉換文件，請稍後再試。"
  switch (error.kind) {
    case "needsOcr":
      return "這份 PDF 需要 OCR，目前只支援含可擷取文字的 PDF。"
    case "encrypted":
      return "這份文件有密碼或已加密，無法讀取。"
    case "unsupported":
      return "目前不支援這種文件格式。"
    case "malformed":
    case "missingPart":
      return "文件內容損毀或缺少必要部分，無法讀取。"
    case "resourceLimit":
      return "文件內容過於複雜，已基於安全限制停止轉換。"
    case "timeout":
      return "文件轉換逾時，請改用較小或較簡單的文件。"
    case "empty":
      return "文件沒有可讀取的內容。"
  }
}

function isAllowed(context: Context, whitelist: ReadonlySet<number>): boolean {
  return (
    whitelist.size === 0 ||
    whitelist.has(context.chat?.id ?? Number.NaN) ||
    whitelist.has(context.from?.id ?? Number.NaN)
  )
}

function replyOptions(
  context: Context,
): { reply_parameters: { message_id: number } } | Record<string, never> {
  return context.message ? { reply_parameters: { message_id: context.message.message_id } } : {}
}
