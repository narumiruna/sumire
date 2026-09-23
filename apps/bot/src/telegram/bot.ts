import type { RunnerHandle } from "@grammyjs/runner"
import { createPublicUrlLoader, type PublicUrlLoader } from "@narumitw/sumire-url-tool"
import { Bot, type Context, GrammyError, HttpError } from "grammy"
import type { UserFromGetMe } from "grammy/types"

import type { ChatSessionRegistry, SubmissionIntent } from "../agent/session-registry.js"
import { buildBlogPostPrompt } from "../blog-post/prompt.js"
import {
  ArticleUrlBudgetError,
  type ArticleUrlContent,
  loadArticleSourceUrls,
  TooManyArticleUrlsError,
} from "../blog-post/source.js"
import type { Settings } from "../config/settings.js"
import { DocumentConversionError, type DocumentConverter } from "../documents/converter.js"
import { promptWithDocumentContext } from "../documents/prompt.js"
import { type Logger, withLogSpan } from "../logging.js"
import { MarketDataInputError, queryMarketData } from "../market-data/query.js"
import { createMorselPublisher, MorselPublishError, type MorselPublisher } from "../morsel.js"
import { singleUrlFingerprint, traceUrlLoad } from "../url-telemetry.js"
import { type AudioTranscriber, promptWithAudioContext, TelegramAudioTranscriber } from "./audio.js"
import { createTelegramDelivery, type DeliveryMode, morselPublicationFailure } from "./delivery.js"
import {
  downloadTelegramFile,
  downloadTelegramImage,
  TelegramDownloadTooLargeError,
} from "./files.js"
import {
  audioReferences,
  captionCommandArguments,
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
  audioTranscriber?: AudioTranscriber
  articleUrlLoader?: PublicUrlLoader
}

interface InputSubmissionOptions {
  promptTransform?: (prompt: string, loadedUrls: readonly ArticleUrlContent[]) => string
  articleUrlSource?: string
  deliveryMode?: DeliveryMode
  includeBotReplyContext?: boolean
  submissionIntent?: SubmissionIntent
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
  const activeArticleLoads = new Map<number, Set<AbortController>>()
  const submissionGenerations = new Map<
    number,
    { generation: number; reason: "reset" | "cancel" }
  >()
  let runner: RunnerHandle | undefined
  const morselPublisher = dependencies.morselPublisher ?? createMorselPublisher(settings)
  const articleUrlLoader =
    dependencies.articleUrlLoader ??
    createPublicUrlLoader({
      allowedSchemes: settings.botUrlAllowedSchemes,
      maxChars: settings.botUrlMaxExtractedChars,
      timeoutMs: settings.botUrlTimeoutSeconds * 1_000,
      urlContentTimeoutSeconds: settings.botUrlContentTimeoutSeconds,
    })
  const audioTranscriber =
    dependencies.audioTranscriber ??
    new TelegramAudioTranscriber({
      maxConcurrency: 1,
      timeoutMs: settings.botAudioTranscriptionTimeoutSeconds * 1_000,
      maxChars: settings.botAudioMaxTranscriptChars,
    })
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
        "/f <內容> — 將內容或回覆的訊息整理成台灣繁體中文文章",
        "/t <代碼> — 查詢股票、虛擬貨幣或匯率（例如 AAPL、2330、BTCUSDT、TWDJPY）",
        "/reset — 清除目前 chat 的 Pi session",
        "/cancel — 取消目前任務與待處理輸入，並清除 steering/follow-up queue",
        "/id — 顯示 chat ID 與 user ID",
        ...(settings.botDocumentInputEnabled
          ? ["可附加 Word、PowerPoint、試算表、OpenDocument、RTF、EPUB、CSV 或文字型 PDF。"]
          : []),
        ...(settings.botAudioInputEnabled ? ["可傳送語音訊息或音訊檔以轉錄並提問。"] : []),
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
  bot.command("f", (context) => submitArticle(context, context.match.trim()))
  bot.on("message:caption_entities:bot_command", async (context, next) => {
    const source = captionCommandArguments(
      context.message as unknown as TelegramMessageLike,
      "f",
      context.me.username,
    )
    if (source === undefined) {
      await next()
      return
    }
    await submitArticle(context, source)
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

  async function submitArticle(context: Context, source: string): Promise<void> {
    const rawMessage = context.message
    const chat = context.chat
    if (!rawMessage || !chat) return
    const message = rawMessage as unknown as TelegramMessageLike
    const repliedText = message.reply_to_message ? messageText(message.reply_to_message).trim() : ""
    if (
      !source &&
      !repliedText &&
      imageReferences(message).length === 0 &&
      documentReferences(message).length === 0 &&
      audioReferences(message).length === 0
    ) {
      await delivery.reply(
        context,
        "請使用 /f <內容>，或回覆要整理的訊息、圖片或文件後傳送 /f。",
        replyOptions(context),
      )
      return
    }
    if (!morselPublisher.isConfigured) {
      await delivery.reply(
        context,
        morselPublicationFailure(
          new MorselPublishError("MORSEL_API_KEY is not configured"),
          "publish",
        ),
        replyOptions(context),
      )
      return
    }
    await inSubmissionOrder(chat.id, (release, isCurrent) =>
      submitInput(context, message, source, release, isCurrent, {
        promptTransform: buildBlogPostPrompt,
        articleUrlSource: [source, repliedText].filter(Boolean).join("\n"),
        deliveryMode: "publish",
        includeBotReplyContext: true,
        submissionIntent: "newTurn",
      }),
    )
  }

  async function submitInput(
    context: Context,
    message: TelegramMessageLike,
    strippedText: string,
    release: () => void,
    isCurrent: () => boolean,
    submissionOptions: InputSubmissionOptions = {},
  ): Promise<void> {
    const fingerprint = singleUrlFingerprint(strippedText)
    return withLogSpan(
      logger,
      "telegram.request",
      {
        "telegram.chat_id": context.chat?.id ?? 0,
        "telegram.message_id": message.message_id,
        "telegram.update_id": context.update.update_id,
        "telegram.chat_type": context.chat?.type ?? "unknown",
        "telegram.text_chars": strippedText.length,
        "telegram.has_reply": Boolean(message.reply_to_message),
        "telegram.images": imageReferences(message).length,
        "telegram.documents": documentReferences(message).length,
        "telegram.audio": audioReferences(message).length,
        ...(fingerprint ? { "telegram.input_url_fingerprint": fingerprint } : {}),
      },
      async (span) => {
        await processInput(context, message, strippedText, release, isCurrent, submissionOptions)
        span.setAttribute("telegram.outcome", isCurrent() ? "finished" : "cancelled")
      },
    )
  }

  async function processInput(
    context: Context,
    message: TelegramMessageLike,
    strippedText: string,
    release: () => void,
    isCurrent: () => boolean,
    submissionOptions: InputSubmissionOptions,
  ): Promise<void> {
    const imageRefs = imageReferences(message)
    const documentRefs = documentReferences(message)
    const audioRefs = audioReferences(message)
    if (audioRefs.length > 0 && !settings.botAudioInputEnabled) {
      await delivery.reply(context, "目前未啟用音訊輸入。", replyOptions(context))
      return
    }
    if (audioRefs.some((reference) => reference.duration > settings.botAudioMaxDurationSeconds)) {
      await delivery.reply(context, "音訊長度超過允許的限制。", replyOptions(context))
      return
    }
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
    const transcripts: Array<{
      source: "current" | "replied"
      kind: "voice" | "audio"
      text: string
    }> = []
    try {
      for (const reference of audioRefs) {
        const text = await audioTranscriber.transcribe(async () => {
          if (!isCurrent()) throw new Error("Telegram audio input was invalidated")
          return downloadTelegramFile(
            context.api,
            settings.botToken,
            reference,
            settings.botAudioMaxBytes,
            dependencies.imageFetchImplementation,
          )
        }, isCurrent)
        if (!isCurrent()) return
        transcripts.push({ source: reference.source, kind: reference.kind, text })
      }
    } catch (error) {
      if (!isCurrent()) return
      logger.warn(`Telegram audio input failed for chat_id=${context.chat?.id}`, error)
      await delivery.reply(
        context,
        error instanceof TelegramDownloadTooLargeError
          ? "音訊超過允許的大小，無法處理。"
          : "無法下載或轉錄音訊，請稍後再試。",
        replyOptions(context),
      )
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
    let prompt =
      documentInputs.length > 0
        ? promptWithDocumentContext(
            strippedText,
            documentInputs,
            settings.botDocumentMaxMarkdownChars,
          )
        : strippedText ||
          (images.length > 0
            ? defaultImagePrompt
            : transcripts.length > 0
              ? "請回應這段音訊的內容。"
              : "請回應這則訊息。")
    if (transcripts.length > 0) prompt = promptWithAudioContext(prompt, transcripts)
    prompt = promptWithReplyContext(message, prompt, submissionOptions.includeBotReplyContext)
    let loadedUrls: ArticleUrlContent[] = []
    if (submissionOptions.articleUrlSource !== undefined) {
      const chatId = context.chat?.id
      const controller = new AbortController()
      const active =
        chatId === undefined ? undefined : (activeArticleLoads.get(chatId) ?? new Set())
      if (chatId !== undefined && active) activeArticleLoads.set(chatId, active)
      active?.add(controller)
      try {
        loadedUrls = await loadArticleSourceUrls(
          submissionOptions.articleUrlSource,
          {
            load: (url, options) =>
              traceUrlLoad(logger, url, undefined, "article-source", () =>
                articleUrlLoader.load(url, options),
              ),
          },
          {
            maxChars: settings.botUrlMaxExtractedChars,
            timeoutMs: Math.min(30, settings.botUrlContentTimeoutSeconds) * 1_000,
            signal: controller.signal,
          },
        )
      } catch (error) {
        if (!isCurrent()) return
        logger.warn(
          "Article source URL loading failed",
          error instanceof TooManyArticleUrlsError
            ? undefined
            : { name: error instanceof Error ? error.name : "unknown" },
        )
        await delivery.reply(
          context,
          error instanceof TooManyArticleUrlsError
            ? "每篇文章最多可處理 4 個網址，請減少網址後再試。"
            : error instanceof ArticleUrlBudgetError
              ? "網址內容長度上限不足，請提高 BOT_URL_MAX_EXTRACTED_CHARS 後再試。"
              : "無法載入文章來源網址，請確認網址可公開存取後再試。",
          replyOptions(context),
        )
        return
      } finally {
        controller.abort()
        active?.delete(controller)
        if (chatId !== undefined && active?.size === 0) activeArticleLoads.delete(chatId)
      }
    }
    if (!isCurrent()) return
    prompt = submissionOptions.promptTransform?.(prompt, loadedUrls) ?? prompt
    await answer(
      context,
      prompt,
      images,
      release,
      isCurrent,
      repliedBotMessageId(message, context.me.id),
      submissionOptions.deliveryMode,
      submissionOptions.includeBotReplyContext,
      submissionOptions.submissionIntent,
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
    finalDeliveryMode: DeliveryMode = "default",
    replyContextIncluded = false,
    submissionIntent?: SubmissionIntent,
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
          ? replyContextIncluded
            ? prompt
            : promptWithReplyContext(
                context.message as unknown as TelegramMessageLike,
                prompt,
                true,
              )
          : undefined
      const result = await withLogSpan(
        logger,
        "pi.submit",
        {
          "telegram.chat_id": chatId,
          "telegram.message_id": sourceMessageId ?? 0,
          "pi.intent": submissionIntent ?? "automatic",
          "pi.reply_to_bot_message_id": replyToBotMessageId ?? 0,
          "pi.prompt_chars": prompt.length,
          "pi.image_count": images.length,
        },
        async (span) => {
          const submission = await sessions.submit(chatId, prompt, {
            images,
            ...(submissionIntent ? { intent: submissionIntent } : {}),
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
          span.setAttribute("pi.outcome", submission.kind)
          if (submission.kind === "completed" && submission.checkpoint) {
            span.setAttribute("pi.session_id", submission.checkpoint.sessionId)
            span.setAttribute("pi.entry_id", submission.checkpoint.entryId)
          }
          return submission
        },
      )
      if (!isCurrent()) {
        await cancelStatus()
        return
      }
      await progressStatus.close()
      const resultDeliveryMode = result.kind === "completed" ? finalDeliveryMode : "default"
      const deliveryResult = await withLogSpan(
        logger,
        "telegram.deliver",
        {
          "telegram.chat_id": chatId,
          "telegram.message_id": sourceMessageId ?? 0,
          "delivery.mode": resultDeliveryMode,
          "delivery.content_chars": result.text.length,
        },
        async (span) => {
          let outcome: "delivered" | "unavailable" | "stale"
          if (status) {
            outcome = await delivery.edit(
              context,
              status.chat.id,
              status.message_id,
              result.text,
              isCurrent,
              resultDeliveryMode,
            )
          } else {
            const finalReply = await delivery.guardedReply(
              context,
              result.text,
              replyOptions,
              isCurrent,
              resultDeliveryMode,
            )
            status = finalReply.message
            outcome = finalReply.result
          }
          span.setAttribute("delivery.outcome", outcome)
          if (status) span.setAttribute("delivery.message_id", status.message_id)
          return outcome
        },
      )
      if (deliveryResult === "stale") {
        await cancelStatus()
        return
      }
      if (deliveryResult === "delivered" && status && result.kind === "completed") {
        await sessions.recordDelivery(chatId, result.checkpoint, [status.message_id])
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
    for (const controller of activeArticleLoads.get(chatId) ?? []) controller.abort()
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
