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
import { createLogger, type Logger } from "./logging.js"
import { createTelegramAgentBot } from "./telegram/bot.js"
import { ChannelImageIndex } from "./telegram/channel-images.js"

export async function startApplication(): Promise<void> {
  const logger = createLogger(
    process.argv.includes("--verbose") || process.argv.includes("-v"),
    process.env.LOGFIRE_TOKEN?.trim() || undefined,
  )
  let adminStore: AdminStore | undefined
  let mcp: McpAdmin | undefined
  let githubAuth: GitHubAuth | undefined
  let adminServer: Awaited<ReturnType<typeof startAdmin>> | undefined
  let sessions: ChatSessionRegistry | undefined
  let github: GithubMentionWorker | undefined
  let closeRuntime: (() => Promise<void>) | undefined

  await runApplicationLifecycle(
    logger,
    async () => {
      const defaultProjectRoot = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../..",
      )
      const settings = loadSettings(process.env, defaultProjectRoot, process.cwd())
      if (!settings.botToken) throw new Error("BOT_TOKEN is required")

      const store = new AdminStore(
        path.join(settings.projectRoot, ".telegramagent/admin.sqlite"),
        settings.botAdminId,
      )
      adminStore = store
      const runtime = new RuntimeConfigAdmin(store, process.env.ENCRYPTION_KEY)
      runtime.importLegacy(process.env)
      mcp = new McpAdmin(store, settings.botWorkdir, runtime)
      githubAuth = new GitHubAuth(store, runtime)
      const control = { store, mcp, runtime, github: githubAuth }
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

      let closing: Promise<void> | undefined
      const drainRuntime = () =>
        (closing ??= closeApplicationResources(
          [
            { name: "github_worker", close: () => github?.close() },
            { name: "telegram", close: () => telegram.stop() },
            { name: "admin_server", close: () => adminServer?.stop() },
            { name: "sessions", close: () => registry.dispose() },
          ],
          logger,
        ))
      closeRuntime = drainRuntime
      let stopping = false
      const stop = async (signal: "SIGINT" | "SIGTERM") => {
        if (stopping) return
        stopping = true
        logger.info("Stopping application", {
          "event.name": "application.stopping",
          "application.signal": signal,
        })
        await drainRuntime()
      }
      const reportShutdownFailure = (error: unknown) =>
        logger.error("Application shutdown failed", {
          "event.name": "application.shutdown.failed",
          error,
        })
      const onInterrupt = () => void stop("SIGINT").catch(reportShutdownFailure)
      const onTerminate = () => void stop("SIGTERM").catch(reportShutdownFailure)
      process.once("SIGINT", onInterrupt)
      process.once("SIGTERM", onTerminate)

      try {
        await telegram.start()
      } finally {
        process.removeListener("SIGINT", onInterrupt)
        process.removeListener("SIGTERM", onTerminate)
      }
    },
    () =>
      closeApplicationResources(
        [
          ...(closeRuntime
            ? [{ name: "runtime", close: closeRuntime }]
            : [
                { name: "github_worker", close: () => github?.close() },
                { name: "admin_server", close: () => adminServer?.stop() },
                { name: "sessions", close: () => sessions?.dispose() },
              ]),
          { name: "github_auth", close: () => githubAuth?.close() },
          { name: "mcp", close: () => mcp?.close() },
          { name: "admin_store", close: () => adminStore?.close() },
        ],
        logger,
      ),
  )
}

/** Record application failures before the configured logger's final flush. */
export async function runApplicationLifecycle(
  logger: Logger,
  run: () => Promise<void>,
  close: () => Promise<void>,
): Promise<void> {
  let failed = false
  let failure: unknown
  logger.info("Starting application", { "event.name": "application.starting" })
  try {
    await run()
  } catch (error) {
    failed = true
    failure = error
    logger.error("Application failed", { "event.name": "application.failed", error })
  }
  try {
    await close()
  } catch (error) {
    if (!failed) {
      failed = true
      failure = error
    }
    logger.error("Application cleanup failed", {
      "event.name": "application.cleanup.failed",
      error,
    })
  }
  if (!failed) logger.info("Application stopped", { "event.name": "application.stopped" })
  try {
    await logger.shutdown?.()
  } catch (error) {
    // createLogger contains exporter failures; custom loggers must not replace the application error.
    logger.warn("Application telemetry shutdown failed", {
      "event.name": "application.telemetry.shutdown.failed",
      error,
    })
  }
  if (failed) throw failure
}

interface ApplicationResource {
  name: string
  close: () => void | Promise<void>
}

export async function closeApplicationResources(
  resources: readonly ApplicationResource[],
  logger?: Logger,
): Promise<void> {
  const failures: unknown[] = []
  for (const resource of resources) {
    try {
      await resource.close()
    } catch (error) {
      failures.push(error)
      logger?.error("Application resource cleanup failed", {
        "event.name": "application.resource.failed",
        "application.resource": resource.name,
        error,
      })
    }
  }
  if (failures.length) throw new AggregateError(failures, "Application cleanup failed")
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
