import path from "node:path"
import { fileURLToPath } from "node:url"
import { createPiSessionFactory } from "./agent/pi-session-factory.js"

import { asSessionCreator, ChatSessionRegistry } from "./agent/session-registry.js"
import { loadSettings } from "./config/settings.js"
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
    const piFactory = await createPiSessionFactory(settings, logger)
    const sessions = new ChatSessionRegistry(
      asSessionCreator(piFactory),
      settings.botSessionLogDir,
      logger,
    )
    const telegram = createTelegramAgentBot(settings, sessions, logger)

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
