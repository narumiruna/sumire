import { readFile } from "node:fs/promises"
import path from "node:path"

import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import progressExtension from "@narumitw/sumire-progress"
import { urlContentSkillsPath } from "@narumitw/sumire-url-content/resources"
import { createUrlExtension, urlToolSkillsPath } from "@narumitw/sumire-url-tool"

import type { Settings } from "../config/settings.js"
import type { Logger } from "../logging.js"
import { buildMorselTools, createMorselPublisher } from "../morsel.js"
import { traceUrlLoad } from "../url-telemetry.js"

const providerId = "telegramagent-openai"
const selectableUrlLoaders = ["built-in", "httpx", "curl-cffi", "playwright", "firecrawl"]
const soulSectionPlaceholder = "{{SOUL_SECTION}}"

export interface PiSessionFactory {
  create(chatId: number): Promise<AgentSession>
}

export async function createPiSessionFactory(
  settings: Settings,
  logger: Logger,
): Promise<PiSessionFactory> {
  const agentDir = path.join(settings.botSessionLogDir, ".pi-agent")
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(agentDir, "models-store.json"),
    refreshOnCreate: false,
  })
  modelRuntime.registerProvider(providerId, {
    name: "telegramagent OpenAI-compatible provider",
    baseUrl: settings.openaiBaseUrl,
    api: "openai-completions",
    authHeader: true,
    models: [
      {
        id: settings.openaiModel,
        name: settings.openaiModel,
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: settings.botAgentContextTokenBudget,
        maxTokens: Math.min(
          settings.botAgentContextTokenBudget,
          Math.max(1, Math.min(32_768, Math.floor(settings.botAgentContextTokenBudget * 0.2))),
        ),
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
        },
      },
    ],
  })
  if (settings.openaiApiKey) {
    await modelRuntime.setRuntimeApiKey(providerId, settings.openaiApiKey)
  }

  const model = modelRuntime.getModel(providerId, settings.openaiModel)
  if (!model)
    throw new Error(`Pi model registration failed for ${providerId}/${settings.openaiModel}`)

  const systemPrompt = await buildSystemPrompt(settings)
  const piSettings = SettingsManager.inMemory({
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
    selectableLoaders: selectableUrlLoaders,
    traceLoad: (url, requestedLoader, toolCallId, load) =>
      traceUrlLoad(logger, url, requestedLoader, toolCallId, load),
  })

  return {
    async create(chatId: number) {
      const resourceLoader = new DefaultResourceLoader({
        cwd: settings.projectRoot,
        agentDir,
        additionalSkillPaths: [
          settings.botSkillsDir,
          urlToolSkillsPath,
          ...(settings.botCodingToolsEnabled ? [urlContentSkillsPath] : []),
        ],
        extensionFactories: [
          { name: "sumire-progress", factory: progressExtension },
          { name: "sumire-url-tool", factory: urlExtension },
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

      const sessionDirectory = path.join(settings.botSessionLogDir, String(chatId), "pi")
      const { session, modelFallbackMessage } = await createAgentSession({
        cwd: settings.projectRoot,
        agentDir,
        model,
        thinkingLevel: "off",
        modelRuntime,
        ...(settings.botCodingToolsEnabled ? {} : { noTools: "builtin" as const }),
        customTools,
        resourceLoader,
        sessionManager: SessionManager.continueRecent(settings.projectRoot, sessionDirectory),
        settingsManager: piSettings,
      })
      if (modelFallbackMessage)
        logger.warn(`Pi session model fallback for chat_id=${chatId}: ${modelFallbackMessage}`)
      return session
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
