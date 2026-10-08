import path from "node:path"
import { fileURLToPath } from "node:url"
import { createPiSessionFactory } from "./agent/pi-session-factory.js"
import { asSessionCreator, ChatSessionRegistry } from "./agent/session-registry.js"
import { loadSettings } from "./config/settings.js"
import { AnyDocConverter, type DocumentConverter } from "./documents/converter.js"
import { createLogger } from "./logging.js"
import { createTelegramAgentBot } from "./telegram/bot.js"
import { ChannelImageIndex } from "./telegram/channel-images.js"

export async function startApplication(): Promise<void> {
  const defaultProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
  const settings = loadSettings(process.env, defaultProjectRoot, process.cwd())
  if (!settings.botToken) throw new Error("BOT_TOKEN is required")

  const logger = createLogger(
    process.argv.includes("--verbose") || process.argv.includes("-v"),
    settings.logfireToken,
  )
  try {
    const documentConverter = await createConfiguredDocumentConverter(settings)
    const channelImages = new ChannelImageIndex(settings.botSessionLogDir, logger)
    const piFactory = await createPiSessionFactory(settings, logger, channelImages)
    const sessions = new ChatSessionRegistry(
      asSessionCreator(piFactory),
      settings.botSessionLogDir,
      logger,
      {
        replyTreeEnabled: settings.botReplyTreeEnabled,
        replyTreeMaxRecordsPerChat: settings.botReplyTreeMaxRecordsPerChat,
        replyTreeMaxIndexBytes: settings.botReplyTreeMaxIndexBytes,
      },
    )
    const telegram = createTelegramAgentBot(settings, sessions, logger, {
      ...(documentConverter ? { documentConverter } : {}),
      channelImages,
      login: piFactory.login,
      recoverChats: () => piFactory.listChats(),
    })

    let stopping = false
    const stop = async (signal: string) => {
      if (stopping) return
      stopping = true
      logger.info(`Received ${signal}; stopping Telegram bot`)
      await Promise.all([telegram.stop(), sessions.dispose()])
    }
    process.once("SIGINT", () => void stop("SIGINT"))
    process.once("SIGTERM", () => void stop("SIGTERM"))

    try {
      await telegram.start()
    } finally {
      await telegram.stop()
      await sessions.dispose()
    }
  } finally {
    await logger.shutdown?.()
  }
}

type DocumentConverterFactory = (options: {
  timeoutMs: number
  maxMarkdownChars: number
  maxConcurrency: number
}) => Promise<DocumentConverter>

export async function createConfiguredDocumentConverter(
  settings: Pick<
    ReturnType<typeof loadSettings>,
    | "botDocumentInputEnabled"
    | "botDocumentConversionTimeoutSeconds"
    | "botDocumentMaxMarkdownChars"
    | "botDocumentMaxConcurrentConversions"
  >,
  create: DocumentConverterFactory = (options) => AnyDocConverter.create(options),
): Promise<DocumentConverter | undefined> {
  if (!settings.botDocumentInputEnabled) return undefined
  try {
    return await create({
      timeoutMs: Math.round(settings.botDocumentConversionTimeoutSeconds * 1_000),
      maxMarkdownChars: settings.botDocumentMaxMarkdownChars,
      maxConcurrency: settings.botDocumentMaxConcurrentConversions,
    })
  } catch (error) {
    throw new Error(
      "Document input is enabled, but the @firecrawl/anydoc native adapter could not load; install the package for this platform or use a supported deployment platform",
      { cause: error },
    )
  }
}
