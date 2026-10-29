import path from "node:path"
import { fileURLToPath } from "node:url"
import { startAdmin } from "./admin/application.js"
import { GitHubAuth } from "./admin/github-auth.js"
import { McpAdmin } from "./admin/mcp.js"
import { RuntimeConfigAdmin } from "./admin/runtime-config.js"
import { AdminStore } from "./admin/store.js"
import { createPiSessionFactory } from "./agent/pi-session-factory.js"
import { asSessionCreator, ChatSessionRegistry } from "./agent/session-registry.js"
import { loadSettings } from "./config/settings.js"
import { AnyDocConverter, type DocumentConverter } from "./documents/converter.js"
import { type GithubMentionWorker, startGithubMentionWorker } from "./github/runtime.js"
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
  let adminStore: AdminStore | undefined
  let control:
    | { store: AdminStore; mcp: McpAdmin; runtime: RuntimeConfigAdmin; github: GitHubAuth }
    | undefined
  let adminServer: Awaited<ReturnType<typeof startAdmin>> | undefined
  let sessions: ChatSessionRegistry | undefined
  let github: GithubMentionWorker | undefined
  try {
    const store = new AdminStore(
      path.join(settings.projectRoot, ".telegramagent/admin.sqlite"),
      settings.botAdminId,
    )
    adminStore = store
    const runtime = new RuntimeConfigAdmin(store, process.env.ENCRYPTION_KEY)
    runtime.importLegacy(process.env)
    const mcp = new McpAdmin(store, settings.botWorkdir, runtime)
    const githubAuth = new GitHubAuth(store, runtime)
    control = { store, mcp, runtime, github: githubAuth }
    await mcp.import(settings.botMcpConfigPath)
    const documentConverter = await createConfiguredDocumentConverter(settings)
    const channelImages = new ChannelImageIndex(settings.botSessionLogDir, logger)
    const piFactory = await createPiSessionFactory(settings, logger, control, channelImages)
    const registry = new ChatSessionRegistry(
      asSessionCreator(piFactory),
      settings.botSessionLogDir,
      logger,
      {
        control: store,
        replyTreeEnabled: settings.botReplyTreeEnabled,
        replyTreeMaxRecordsPerChat: settings.botReplyTreeMaxRecordsPerChat,
        replyTreeMaxIndexBytes: settings.botReplyTreeMaxIndexBytes,
      },
    )
    sessions = registry
    adminServer = await startAdmin(settings.admin, control, piFactory, registry)
    if (!piFactory.modelRuntime) throw new Error("Shared model runtime is unavailable")
    github = startGithubMentionWorker(settings, logger, control, piFactory.modelRuntime)
    const telegram = createTelegramAgentBot(settings, registry, logger, {
      ...(documentConverter ? { documentConverter } : {}),
      channelImages,
      control: store,
      runtime,
      recoverChats: () => piFactory.listChats(),
    })

    const closeRuntime = () =>
      closeApplicationResources([
        () => github?.close(),
        () => telegram.stop(),
        () => adminServer?.stop(),
        () => registry.dispose(),
      ])
    let stopping = false
    const stop = async (signal: string) => {
      if (stopping) return
      stopping = true
      logger.info(`Received ${signal}; stopping Telegram bot`)
      await closeRuntime()
      adminServer = undefined
    }
    const onInterrupt = () =>
      void stop("SIGINT").catch(() => logger.warn("Application shutdown failed"))
    const onTerminate = () =>
      void stop("SIGTERM").catch(() => logger.warn("Application shutdown failed"))
    process.once("SIGINT", onInterrupt)
    process.once("SIGTERM", onTerminate)

    try {
      await telegram.start()
    } finally {
      process.removeListener("SIGINT", onInterrupt)
      process.removeListener("SIGTERM", onTerminate)
      await closeRuntime()
    }
  } finally {
    await closeApplicationResources([
      () => github?.close(),
      () => adminServer?.stop(),
      () => sessions?.dispose(),
      () => control?.github.close(),
      () => control?.mcp.close(),
      () => adminStore?.close(),
      () => logger.shutdown?.(),
    ])
  }
}

export async function closeApplicationResources(closers: Array<() => void | Promise<void>>) {
  let failed = false
  for (const close of closers) {
    try {
      await close()
    } catch {
      failed = true
    }
  }
  if (failed) throw new Error("Application cleanup failed")
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
