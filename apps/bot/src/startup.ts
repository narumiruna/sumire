import path from "node:path"
import { fileURLToPath } from "node:url"
import { createPublicUrlLoader } from "./actions/public-url.js"
import { createPiSessionFactory } from "./agent/pi-session-factory.js"
import { asSessionCreator, ChatSessionRegistry } from "./agent/session-registry.js"
import { loadSettings } from "./config/settings.js"
import { AnyDocConverter, type DocumentConverter } from "./documents/converter.js"
import { createLogger } from "./logging.js"
import { createTelegramAgentBot } from "./telegram/bot.js"

export async function startApplication(): Promise<void> {
  const defaultProjectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
  const settings = loadSettings(process.env, defaultProjectRoot)
  if (!settings.botToken) throw new Error("BOT_TOKEN is required")
  if (!settings.openaiApiKey) throw new Error("OPENAI_API_KEY is required")

  const logger = createLogger(
    process.argv.includes("--verbose") || process.argv.includes("-v"),
    settings.logfireToken,
  )
  try {
    const publicUrlLoader = createPublicUrlLoader(settings)
    const documentConverter = await createConfiguredDocumentConverter(settings)
    const piFactory = await createPiSessionFactory(settings, logger, publicUrlLoader)
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
      publicUrlLoader,
    })

    let stopping = false
    const stop = async (signal: string) => {
      if (stopping) return
      stopping = true
      logger.info(`Received ${signal}; stopping Telegram bot`)
      await telegram.stop()
    }
    process.once("SIGINT", () => void stop("SIGINT"))
    process.once("SIGTERM", () => void stop("SIGTERM"))

    try {
      await telegram.start()
    } finally {
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
      "Document input is enabled, but the @firecrawl/anydoc native adapter could not load; install the package for this platform or set BOT_DOCUMENT_INPUT_ENABLED=false",
      { cause: error },
    )
  }
}
