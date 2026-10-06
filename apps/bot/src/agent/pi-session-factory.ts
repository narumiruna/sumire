import { chmod, mkdir, readdir, readFile } from "node:fs/promises"
import path from "node:path"

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import {
  DefaultResourceLoader,
  formatSkillsForPrompt,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent"
import { createRegistry, defineExtension, Harness, section } from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import type { OAuthLoginClient } from "@narumitw/sumire-login"
import { urlContentSkillsPath } from "@narumitw/sumire-url-content/resources"
import { createPublicUrlLoader, createUrlTool, urlToolSkillsPath } from "@narumitw/sumire-url-tool"

import type { Settings } from "../config/settings.js"
import type { Logger } from "../logging.js"
import { buildMorselTools, createMorselPublisher } from "../morsel.js"
import { ChannelImageIndex } from "../telegram/channel-images.js"
import { traceUrlLoad } from "../url-telemetry.js"
import { createDurableCodemode } from "./durable-codemode.js"
import { createProgressExtension } from "./durable-progress.js"
import { DurableSession } from "./durable-session.js"
import { adaptTool, codingTools, collectTools } from "./durable-tools.js"
import { createBotModelRuntime } from "./model-runtime.js"
import { createReadImageExtension } from "./read-image.js"

const selectableUrlLoaders = ["built-in", "httpx", "curl-cffi", "playwright", "firecrawl"]
const soulSectionPlaceholder = "{{SOUL_SECTION}}"

export interface PiSessionFactory {
  login?: OAuthLoginClient
  create(chatId: number): Promise<DurableSession>
  listChats(): Promise<number[]>
}

export async function createPiSessionFactory(
  settings: Settings,
  logger: Logger,
  channelImages = new ChannelImageIndex(settings.botSessionLogDir, logger),
  modelRuntimeOverride?: ModelRuntime,
): Promise<PiSessionFactory> {
  if (settings.botWhitelist.size === 0) {
    throw new Error(
      "BOT_WHITELIST must contain a trusted Telegram user or chat ID for coding tools",
    )
  }
  const agentDir = path.join(settings.botSessionLogDir, ".pi-agent")

  const { modelRuntime, model, login } = await createBotModelRuntime(
    settings,
    agentDir,
    modelRuntimeOverride,
  )
  const loader = new DefaultResourceLoader({
    cwd: settings.botWorkdir,
    agentDir,
    additionalSkillPaths: [settings.botSkillsDir, urlToolSkillsPath, urlContentSkillsPath],
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    skillsOverride: (current) => ({
      diagnostics: current.diagnostics,
      skills:
        settings.botEnabledSkills.size === 0
          ? current.skills
          : current.skills.filter((skill) => settings.botEnabledSkills.has(skill.name)),
    }),
  })
  await loader.reload()
  for (const diagnostic of loader.getSkills().diagnostics)
    logger.warn(`Pi skill diagnostic: ${diagnostic.message}`)
  const systemPrompt = [
    await buildSystemPrompt(settings),
    formatSkillsForPrompt(loader.getSkills().skills),
  ]
    .filter(Boolean)
    .join("\n\n")
  const urlTool = createUrlTool(
    createPublicUrlLoader({
      allowedSchemes: settings.botUrlAllowedSchemes,
      maxChars: settings.botUrlMaxExtractedChars,
      timeoutMs: Math.round(settings.botUrlTimeoutSeconds * 1_000),
      urlContentTimeoutSeconds: settings.botUrlContentTimeoutSeconds,
      firecrawlFallback: true,
    }),
    {
      selectableLoaders: selectableUrlLoaders,
      traceLoad: (url, requestedLoader, toolCallId, load) =>
        traceUrlLoad(logger, url, requestedLoader, toolCallId, load),
    },
  )
  const nativeTools = [
    ...codingTools(settings.botWorkdir),
    urlTool,
    ...buildMorselTools(createMorselPublisher(settings), settings.morselMode, logger),
    ...(settings.botChannelImageInputEnabled && settings.botImageInputEnabled
      ? await collectTools(createReadImageExtension(settings, channelImages, logger))
      : []),
  ]

  return {
    login,

    async listChats() {
      try {
        const entries = await readdir(settings.botSessionLogDir, { withFileTypes: true })
        const chats: number[] = []
        for (const entry of entries) {
          const id = Number(entry.name)
          if (!entry.isDirectory() || !Number.isSafeInteger(id) || String(id) !== entry.name)
            continue
          try {
            const files = await readdir(path.join(settings.botSessionLogDir, entry.name, "durable"))
            if (files.includes("session.sqlite")) chats.push(id)
          } catch (error) {
            if (!isMissing(error)) throw error
          }
        }
        return chats
      } catch (error) {
        if (isMissing(error)) return []
        throw error
      }
    },
    async create(chatId) {
      const selectedModel = (await modelRuntime.checkAuth(model.provider))
        ? model
        : (await modelRuntime.getAvailable())[0]
      if (!selectedModel) throw new Error("尚未設定 Pi 驗證，請管理員在私聊使用 /login。")
      const directory = path.join(settings.botSessionLogDir, String(chatId), "durable")
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await chmod(directory, 0o700)
      const sessionFile = path.join(directory, "session.sqlite")
      const registry = createRegistry()
      registry.install(
        defineExtension({
          name: "sumire",
          tools: nativeTools.map(adaptTool),
          sections: [section("system", () => systemPrompt, { tag: false })],
        }),
      )
      registry.install(createProgressExtension())
      let harness: Harness | undefined
      let session: DurableSession | undefined
      if (settings.botCodemodeEnabled)
        registry.install(
          await createDurableCodemode(
            nativeTools,
            Math.round(settings.botCodemodeTimeoutSeconds * 1_000),
            () => {
              if (!harness) throw new Error("Durable harness is not open")
              return harness
            },
            (event) => session?.emit(event),
          ),
        )
      const storage = await openNodeSqliteStorage(sessionFile)
      try {
        await chmod(sessionFile, 0o600)
        harness = await Harness.open(
          storage,
          {
            models: modelRuntime,
            registry,
            settings: {
              compaction: {
                enabled: true,
                reserveTokens: Math.max(
                  1,
                  Math.round(
                    settings.botAgentContextTokenBudget *
                      (1 - settings.botAgentCompactionTriggerRatio),
                  ),
                ),
                backgroundTokens: 0,
              },
              retry: {
                enabled: true,
                maxRetries: Math.max(0, settings.botAgentMaxAttempts - 1),
                baseDelayMs: Math.round(settings.botAgentRetryBaseDelaySeconds * 1_000),
              },
              followUpMode: "one-at-a-time",
              steeringMode: "one-at-a-time",
            },
            onReport: (error) => logger.warn(`Durable runtime error for chat_id=${chatId}`, error),
          },
          context,
        )
        await harness.root(context, {
          agent: {
            model: { provider: selectedModel.provider, modelId: selectedModel.id },
            thinkingLevel: "off",
            cwd: settings.botWorkdir,
          },
        })

        session = await DurableSession.open({
          harness,
          sessionFile,
          cwd: settings.botWorkdir,
          model: selectedModel,
          modelRuntime,
          registry,
          systemPrompt,
          nativeTools,
          logger,
          trustKey: JSON.stringify([...settings.botWhitelist].sort((a, b) => a - b)),
        })
        return session
      } catch (error) {
        if (harness) await harness.close(context)
        else await storage.close(context)
        logger.error(`Durable session initialization failed for chat_id=${chatId}`, error)
        throw error
      }
    },
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

async function buildSystemPrompt(settings: Settings): Promise<string> {
  const [template, soul] = await Promise.all([
    readFile(settings.botSystemPromptPath, "utf8"),
    loadSoul(settings),
  ])
  if (template.split(soulSectionPlaceholder).length - 1 !== 1) {
    throw new Error(
      `Bot system prompt template must contain exactly one ${soulSectionPlaceholder} placeholder`,
    )
  }
  return template.replace(soulSectionPlaceholder, soul ? `## SOUL.md\n\n${soul}` : "").trim()
}

async function loadSoul(settings: Settings): Promise<string> {
  try {
    return (await readFile(settings.botSoulPath, "utf8")).slice(0, settings.botSoulMaxChars)
  } catch (error) {
    if (!settings.botSoulRequired && isMissing(error)) return ""
    throw error
  }
}
