import { readFile } from "node:fs/promises"
import path from "node:path"

import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import type { OAuthLoginClient } from "@narumitw/sumire-login"
import progressExtension from "@narumitw/sumire-progress"
import { urlContentSkillsPath } from "@narumitw/sumire-url-content/resources"
import { createUrlExtension, urlToolSkillsPath } from "@narumitw/sumire-url-tool"

import type { Settings } from "../config/settings.js"
import type { Logger } from "../logging.js"
import { buildMorselTools, createMorselPublisher } from "../morsel.js"
import { ChannelImageIndex } from "../telegram/channel-images.js"
import { traceUrlLoad } from "../url-telemetry.js"
import { createBotCodemodeExtension } from "./codemode.js"
import { createBotModelRuntime } from "./model-runtime.js"
import { createReadImageExtension } from "./read-image.js"

const selectableUrlLoaders = ["built-in", "httpx", "curl-cffi", "playwright", "firecrawl"]
const soulSectionPlaceholder = "{{SOUL_SECTION}}"

export interface PiSessionFactory {
  login?: OAuthLoginClient
  create(chatId: number): Promise<AgentSession>
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

  const systemPrompt = await buildSystemPrompt(settings)
  const piSettings = SettingsManager.inMemory({
    defaultTools: [
      "read",
      "bash",
      "edit",
      "write",
      ...(settings.botCodemodeEnabled ? ["codemode"] : []),
    ],
    compaction: {
      enabled: true,
      reserveTokens: Math.max(
        1,
        Math.round(
          settings.botAgentContextTokenBudget * (1 - settings.botAgentCompactionTriggerRatio),
        ),
      ),
    },
    followUpMode: "one-at-a-time",
    retry: {
      enabled: true,
      maxRetries: Math.max(0, settings.botAgentMaxAttempts - 1),
      baseDelayMs: Math.round(settings.botAgentRetryBaseDelaySeconds * 1_000),
    },
    steeringMode: "one-at-a-time",
  })

  const morselPublisher = createMorselPublisher(settings)
  const customTools = buildMorselTools(morselPublisher, settings.morselMode, logger)
  const urlExtension = createUrlExtension({
    allowedSchemes: settings.botUrlAllowedSchemes,
    maxChars: settings.botUrlMaxExtractedChars,
    timeoutMs: Math.round(settings.botUrlTimeoutSeconds * 1_000),
    urlContentTimeoutSeconds: settings.botUrlContentTimeoutSeconds,
    firecrawlFallback: true,
    selectableLoaders: selectableUrlLoaders,
    traceLoad: (url, requestedLoader, toolCallId, load) =>
      traceUrlLoad(logger, url, requestedLoader, toolCallId, load),
  })

  return {
    login,
    async create(chatId: number) {
      const sessionDirectory = path.join(settings.botSessionLogDir, String(chatId), "pi")
      const sessionManager = SessionManager.continueRecent(settings.botWorkdir, sessionDirectory)
      const savedContext = sessionManager.buildSessionContext()
      const savedModel = savedContext.model
        ? modelRuntime.getModel(savedContext.model.provider, savedContext.model.modelId)
        : undefined
      const selectedModel =
        savedModel && (await modelRuntime.checkAuth(savedModel.provider)) ? savedModel : model
      if (!(await modelRuntime.checkAuth(selectedModel.provider))) {
        throw new Error("尚未設定 Pi 驗證，請管理員在私聊使用 /login。")
      }
      const resourceLoader = new DefaultResourceLoader({
        cwd: settings.botWorkdir,
        agentDir,
        additionalSkillPaths: [settings.botSkillsDir, urlToolSkillsPath, urlContentSkillsPath],
        extensionFactories: [
          { name: "sumire-progress", factory: progressExtension },
          { name: "sumire-url-tool", factory: urlExtension },
          ...(settings.botCodemodeEnabled
            ? [
                {
                  name: "sumire-codemode",
                  factory: createBotCodemodeExtension(
                    Math.round(settings.botCodemodeTimeoutSeconds * 1_000),
                  ),
                },
              ]
            : []),
          ...(settings.botChannelImageInputEnabled && settings.botImageInputEnabled
            ? [
                {
                  name: "sumire-read-image",
                  factory: createReadImageExtension(settings, channelImages, logger),
                },
              ]
            : []),
        ],
        noExtensions: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt,
        skillsOverride: (current) => ({
          diagnostics: current.diagnostics,
          skills:
            settings.botEnabledSkills.size === 0
              ? current.skills
              : current.skills.filter((skill) => settings.botEnabledSkills.has(skill.name)),
        }),
      })
      await resourceLoader.reload()
      for (const diagnostic of resourceLoader.getSkills().diagnostics) {
        logger.warn(`Pi skill diagnostic for chat_id=${chatId}: ${diagnostic.message}`)
      }
      for (const error of resourceLoader.getExtensions().errors) {
        logger.warn(`Pi extension diagnostic for chat_id=${chatId}: ${error.path}: ${error.error}`)
      }

      const { session, modelFallbackMessage } = await createAgentSession({
        cwd: settings.botWorkdir,
        agentDir,
        model: selectedModel,
        thinkingLevel: savedContext.messages.length > 0 ? undefined : "off",
        modelRuntime,
        customTools,
        resourceLoader,
        sessionManager,
        settingsManager: piSettings,
      })
      if (modelFallbackMessage)
        logger.warn(`Pi session model fallback for chat_id=${chatId}: ${modelFallbackMessage}`)
      try {
        let startupFailed = false
        let initializing = true
        await session.bindExtensions({
          onError: (error) => {
            if (initializing) startupFailed = true
            logger.warn(`Pi extension error for chat_id=${chatId} event=${error.event}`, error)
          },
        })
        initializing = false
        if (startupFailed) throw new Error("Pi extension initialization failed")
        return session
      } catch (error) {
        session.dispose()
        logger.error(`Pi session initialization failed for chat_id=${chatId}`, error)
        throw error
      }
    },
  }
}

async function buildSystemPrompt(settings: Settings): Promise<string> {
  const [template, soul] = await Promise.all([
    readFile(settings.botSystemPromptPath, "utf8"),
    loadSoul(settings),
  ])
  const placeholderCount = template.split(soulSectionPlaceholder).length - 1
  if (placeholderCount !== 1) {
    throw new Error(
      `Bot system prompt template must contain exactly one ${soulSectionPlaceholder} placeholder`,
    )
  }

  const soulSection = soul ? `## SOUL.md\n\n${soul}` : ""
  return template.replace(soulSectionPlaceholder, soulSection).trim()
}

async function loadSoul(settings: Settings): Promise<string> {
  try {
    const content = await readFile(settings.botSoulPath, "utf8")
    return content.slice(0, settings.botSoulMaxChars)
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined
    if (!settings.botSoulRequired && code === "ENOENT") return ""
    throw error
  }
}
