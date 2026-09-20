import { type RunnerHandle, run } from "@grammyjs/runner"
import { Bot, type Context, GrammyError, HttpError } from "grammy"
import type { UserFromGetMe } from "grammy/types"

import {
  classifyProactiveUrl,
  extractTelegramUrls,
  PendingUrlStore,
  promptWithUrlContext,
} from "../actions/proactive-url.js"
import { createPublicUrlLoader, type PublicUrlLoader } from "../actions/public-url.js"
import type { ChatSessionRegistry } from "../agent/session-registry.js"
import type { Settings } from "../config/settings.js"
import { DocumentConversionError, type DocumentConverter } from "../documents/converter.js"
import { promptWithDocumentContext } from "../documents/prompt.js"
import type { Logger } from "../logging.js"
import { createMorselPublisher, type MorselPublisher } from "../morsel.js"
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
import { createProgressStatusEditor, renderProgressStatus } from "./progress.js"
import { sanitizeTelegramText, telegramHtmlChunks } from "./rendering.js"

export interface TelegramAgentBot {
  bot: Bot
  start(): Promise<void>
  stop(): Promise<void>
}

interface TelegramBotDependencies {
  botInfo?: UserFromGetMe
  imageFetchImplementation?: typeof fetch
  documentConverter?: DocumentConverter
  publicUrlLoader?: PublicUrlLoader
  morselPublisher?: Pick<MorselPublisher, "isConfigured" | "publish">
}

const updateConcurrency = 16

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
  const submissionGenerations = new Map<number, number>()
  let runner: RunnerHandle | undefined
  const morselPublisher = dependencies.morselPublisher ?? createMorselPublisher(settings)
  const publicUrlLoader = dependencies.publicUrlLoader ?? createPublicUrlLoader(settings)
  const pendingUrls = new PendingUrlStore(
    settings.botProactivePendingTtlSeconds * 1_000,
    settings.botProactivePendingMaxChats,
  )

  bot.use(async (context, next) => {
    if (!isAllowed(context, settings.botWhitelist)) return
    await next()
  })

  bot.command("start", async (context) => {
    await context.reply("你好！我是由 Pi agent 驅動的 Telegram AI 助理。使用 /help 查看可用指令。")
  })
  bot.command("help", async (context) => {
    await context.reply(
      [
        "/ask <問題> — 詢問 AI 助理",
        "/reset — 清除目前 chat 的 Pi session",
        "/cancel — 取消目前執行並清除 steering/follow-up queue",
        "/id — 顯示 chat ID 與 user ID",
        ...(settings.botDocumentInputEnabled
          ? ["可附加 Word、PowerPoint、試算表、OpenDocument、RTF、EPUB、CSV 或文字型 PDF。"]
          : []),
        ...(settings.botReplyTreeEnabled ? ["回覆較早的 bot 回覆可從該對話分支繼續。"] : []),
        ...(settings.botProactiveEnabled ? ["直接貼上一個公開網址可讀取並摘要。"] : []),
      ].join("\n"),
    )
  })
  bot.command("id", async (context) => {
    await context.reply(`chat_id=${context.chat.id}\nuser_id=${context.from?.id ?? "unknown"}`)
  })
  bot.command("reset", async (context) => {
    const finishReset = invalidateSubmissionOrder(context.chat.id)
    try {
      pendingUrls.clear(context.chat.id)
      await sessions.reset(context.chat.id)
    } finally {
      finishReset()
    }
    await context.reply("已清除這個對話的 Pi session。", replyOptions(context))
  })
  bot.command("cancel", async (context) => {
    const cancelled = await sessions.cancel(context.chat.id)
    await context.reply(
      cancelled ? "已取消目前任務。" : "目前沒有執行中的任務。",
      replyOptions(context),
    )
  })
  bot.command("ask", async (context) => {
    const prompt = context.match.trim()
    if (!prompt) {
      await context.reply("請使用 /ask <問題>。", replyOptions(context))
      return
    }
    await inSubmissionOrder(context.chat.id, (release, isCurrent) =>
      answer(
        context,
        prompt,
        [],
        release,
        isCurrent,
        repliedBotMessageId(context.message as unknown as TelegramMessageLike, context.me.id),
      ),
    )
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
    await inSubmissionOrder(context.chat.id, async (release, isCurrent) => {
      const strippedText = privateChat
        ? messageText(message).trim()
        : stripBotMention(messageText(message), context.me.username)
      const imageRefs = imageReferences(message)
      const documentRefs = documentReferences(message)
      if (imageRefs.length > 0 && !settings.botImageInputEnabled) {
        await context.reply("目前未啟用圖片輸入。", replyOptions(context))
        return
      }
      if (documentRefs.length > 0 && !settings.botDocumentInputEnabled) {
        await context.reply("目前未啟用文件輸入。", replyOptions(context))
        return
      }
      if (documentRefs.length > 0 && !dependencies.documentConverter) {
        await context.reply("文件轉換服務目前無法使用。", replyOptions(context))
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
        const response =
          error instanceof TelegramDownloadTooLargeError
            ? "圖片超過允許的大小，無法處理。"
            : "無法下載 Telegram 圖片，請稍後再試。"
        logger.warn(`Telegram image input failed for chat_id=${context.chat.id}`, error)
        await context.reply(response, replyOptions(context))
        return
      }

      let documentInputs: Array<{
        reference: (typeof documentRefs)[number]
        converted: Awaited<ReturnType<DocumentConverter["convert"]>>
      }> = []
      try {
        documentInputs = await Promise.all(
          documentRefs.map(async (reference) => {
            const bytes = await downloadTelegramFile(
              context.api,
              settings.botToken,
              reference,
              settings.botDocumentMaxBytes,
              dependencies.imageFetchImplementation,
            )
            const converted = await dependencies.documentConverter?.convert(
              bytes,
              reference.filename,
            )
            if (!converted) throw new Error("Document converter is unavailable")
            return { reference, converted }
          }),
        )
      } catch (error) {
        const response = documentFailureMessage(error)
        logger.warn(`Telegram document input failed for chat_id=${context.chat.id}`, error)
        await context.reply(response, replyOptions(context))
        return
      }

      if (!isCurrent()) return
      let prompt: string
      if (settings.botProactiveEnabled && imageRefs.length === 0 && documentRefs.length === 0) {
        const decision = classifyProactiveUrl(strippedText, extractTelegramUrls(message))
        let proactiveUrl: string | undefined
        let instruction = ""
        if (decision.kind === "load") {
          proactiveUrl = decision.url
          instruction = decision.instruction
          pendingUrls.set(context.chat.id, proactiveUrl)
        } else if (decision.kind === "follow_up") {
          proactiveUrl = pendingUrls.get(context.chat.id)
          if (!proactiveUrl) {
            await context.reply("目前沒有可繼續處理的網址。", replyOptions(context))
            return
          }
        }
        if (proactiveUrl) {
          try {
            prompt = promptWithUrlContext(instruction, await publicUrlLoader.load(proactiveUrl))
          } catch (error) {
            logger.warn(`Proactive URL loading failed for chat_id=${context.chat.id}`, error)
            await context.reply(
              "無法安全讀取這個網址；我沒有將內容交給 AI，也不會假裝已讀取。",
              replyOptions(context),
            )
            return
          }
        } else {
          const basePrompt = strippedText || "請回應這則訊息。"
          prompt = promptWithReplyContext(message, basePrompt)
        }
      } else if (documentInputs.length > 0) {
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
    })
  })

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
    const sourceMessageId = context.message?.message_id
    const status = await context.reply(
      "處理中…",
      sourceMessageId ? { reply_parameters: { message_id: sourceMessageId } } : {},
    )
    const progressStatus = createProgressStatusEditor(
      async (text) => {
        if (!isCurrent()) return
        await editStatusWithChunks(context, status.chat.id, status.message_id, text, isCurrent)
      },
      (error) =>
        logger.warn(`Telegram progress update failed for chat_id=${status.chat.id}`, error),
      "處理中…",
    )
    const cancelStatus = async () => {
      await progressStatus.close()
      await editStatusWithChunks(
        context,
        status.chat.id,
        status.message_id,
        "此請求已因重設對話而取消。",
      )
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
      const result = await sessions.submit(context.chat?.id ?? status.chat.id, prompt, {
        images,
        ...(replyToBotMessageId !== undefined ? { replyToBotMessageId } : {}),
        ...(unresolvedReplyPrompt ? { unresolvedReplyPrompt } : {}),
        onAccepted: releaseSubmissionTurn,
        onProgress: (steps) => progressStatus.publish(renderProgressStatus(steps)),
      })
      if (!isCurrent()) {
        await cancelStatus()
        return
      }
      let outboundText = result.text
      const sanitized = sanitizeTelegramText(outboundText)
      if (
        settings.morselMode === "smart" &&
        morselPublisher.isConfigured &&
        sanitized.length > settings.morselLongReplyThreshold
      ) {
        try {
          const shareUrl = await morselPublisher.publish(sanitized)
          outboundText = `完整回覆已發布至 Morsel（${sanitized.length.toLocaleString("zh-TW")} 字）：\n${shareUrl}`
        } catch (error) {
          logger.warn(
            `Morsel long-reply publication failed for chat_id=${status.chat.id}; falling back`,
            error,
          )
        }
      }
      if (!isCurrent()) {
        await cancelStatus()
        return
      }
      await progressStatus.close()
      const deliveredMessageIds = await editStatusWithChunks(
        context,
        status.chat.id,
        status.message_id,
        outboundText,
        isCurrent,
      )
      if (!deliveredMessageIds) {
        await cancelStatus()
        return
      }
      await sessions.recordDelivery(
        status.chat.id,
        result.kind === "completed" ? result.checkpoint : undefined,
        deliveredMessageIds,
      )
    } catch (error) {
      if (!isCurrent()) {
        await cancelStatus()
        return
      }
      logger.error(`Pi agent request failed for chat_id=${status.chat.id}`, error)
      await progressStatus.close()
      if (
        !(await editStatusWithChunks(
          context,
          status.chat.id,
          status.message_id,
          "AI 服務暫時無法使用，請稍後再試。",
          isCurrent,
        ))
      ) {
        await cancelStatus()
      }
    }
  }

  async function inSubmissionOrder(
    chatId: number,
    task: (release: () => void, isCurrent: () => boolean) => Promise<void>,
  ): Promise<void> {
    const generation = submissionGenerations.get(chatId) ?? 0
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
      return (submissionGenerations.get(chatId) ?? 0) === generation
    }
  }

  function invalidateSubmissionOrder(chatId: number): () => void {
    submissionGenerations.set(chatId, (submissionGenerations.get(chatId) ?? 0) + 1)
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
      runner = run(bot, {
        runner: { fetch: { allowed_updates: ["message"] } },
        sink: { concurrency: updateConcurrency },
      })
      await runner.task()
    },
    async stop() {
      if (!runner) return
      await runner.stop()
      runner = undefined
    },
  }
}

async function editStatusWithChunks(
  context: Context,
  chatId: number,
  messageId: number,
  text: string,
  isCurrent: () => boolean = () => true,
): Promise<number[] | undefined> {
  const [first = " ", ...rest] = telegramHtmlChunks(text)
  const continuationMessageIds: number[] = []
  if (!isCurrent()) return undefined
  await context.api.editMessageText(chatId, messageId, first, { parse_mode: "HTML" })
  let replyTo = messageId
  try {
    for (const chunk of rest) {
      if (!isCurrent()) return undefined
      const sent = await context.api.sendMessage(chatId, chunk, {
        parse_mode: "HTML",
        reply_parameters: { message_id: replyTo },
      })
      continuationMessageIds.push(sent.message_id)
      if (!isCurrent()) {
        await deleteContinuations()
        return undefined
      }
      replyTo = sent.message_id
    }
    return isCurrent() ? [messageId, ...continuationMessageIds] : undefined
  } catch (error) {
    await deleteContinuations()
    throw error
  }

  async function deleteContinuations(): Promise<void> {
    await Promise.allSettled(
      continuationMessageIds.map((continuationMessageId) =>
        context.api.deleteMessage(chatId, continuationMessageId),
      ),
    )
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
