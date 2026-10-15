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
import type { McpAdmin } from "../admin/mcp.js"
import { effectivePolicy } from "../admin/policy.js"
import { chatModelRuntime } from "../admin/providers.js"
import { adminShellEnvironment } from "../admin/shell.js"
import type { AdminStore } from "../admin/store.js"
import type { Settings } from "../config/settings.js"
import type { Logger } from "../logging.js"
import { buildMorselTools, createMorselPublisher } from "../morsel.js"
import { ChannelImageIndex } from "../telegram/channel-images.js"
import { traceUrlLoad } from "../url-telemetry.js"
import { createDurableCodemode } from "./durable-codemode.js"
import { createProgressExtension } from "./durable-progress.js"
import { DurableSession } from "./durable-session.js"
import { adaptTool, codingTools, collectTools } from "./durable-tools.js"
import { createMcpTransport, McpCapability } from "./mcp-capability.js"
import { loadMcpConfig } from "./mcp-config.js"
import { createBotModelRuntime } from "./model-runtime.js"
import { createReadImageExtension } from "./read-image.js"

const selectableUrlLoaders = ["built-in", "httpx", "curl-cffi", "playwright", "firecrawl"]
const soulSectionPlaceholder = "{{SOUL_SECTION}}"

export interface PiSessionFactory {
  login?: OAuthLoginClient
  modelRuntime?: ModelRuntime
  toolNames?: string[]
  create(chatId: number): Promise<DurableSession>
  listChats(): Promise<number[]>
}

export async function createPiSessionFactory(
  settings: Settings,
  logger: Logger,
  channelImages = new ChannelImageIndex(settings.botSessionLogDir, logger),
  modelRuntimeOverride?: ModelRuntime,
  control?: { store: AdminStore; mcp: McpAdmin },
): Promise<PiSessionFactory> {
  if (!control && settings.botWhitelist.size === 0) {
    throw new Error(
      "BOT_WHITELIST must contain a trusted Telegram user or chat ID for coding tools",
    )
  }
  const mcpConfig = control ? control.mcp.config() : await loadMcpConfig(settings, logger)
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
  const baseTools = [
    ...codingTools(settings.botWorkdir, control ? adminShellEnvironment(process.env) : undefined),
    urlTool,
    ...buildMorselTools(createMorselPublisher(settings), settings.morselMode, logger),
    ...(settings.botChannelImageInputEnabled && settings.botImageInputEnabled
      ? await collectTools(
          createReadImageExtension(settings, channelImages, logger, undefined, undefined, () =>
            control
              ? new Set(
                  control.store.snapshot().policy.groups.filter((id) => control.store.allows(id)),
                )
              : settings.botWhitelist,
          ),
        )
      : []),
  ]

  return {
    login,
    modelRuntime,
    toolNames: [...baseTools.map((tool) => tool.name), "codemode", "update_progress"],

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
      const state = control?.store.snapshot()
      control?.store.assertChat(chatId, state?.revision)
      const policy = state ? effectivePolicy(state.policy, chatId) : undefined
      const ref = policy?.model
      const requested = ref
        ? modelRuntime.getModel(ref.slice(0, ref.indexOf("/")), ref.slice(ref.indexOf("/") + 1))
        : policy
          ? undefined
          : model
      const selectedModel = policy
        ? requested &&
          policy.models.includes(`${requested.provider}/${requested.id}`) &&
          (await modelRuntime.checkAuth(requested.provider))
          ? requested
          : undefined
        : (await modelRuntime.checkAuth(model.provider))
          ? model
          : (await modelRuntime.getAvailable())[0]
      const runtime = control ? chatModelRuntime(modelRuntime, control.store, chatId) : modelRuntime
      const guard = (tool: import("./durable-tools.js").NativeTool) =>
        control
          ? {
              ...tool,
              execute: (...args: Parameters<typeof tool.execute>) => {
                control.store.assertChat(chatId)
                if (!control.store.allowsTool(chatId, tool.name))
                  throw new Error("Tool is not allowed")
                return tool.execute(...args)
              },
            }
          : tool
      const allowed = (tool: import("./durable-tools.js").NativeTool) =>
        !control || control.store.allowsTool(chatId, tool.name)
      const chatBaseTools = baseTools.filter(allowed).map(guard)
      const chatMcpConfig = control ? control.mcp.config() : mcpConfig
      const permittedMcp = {
        ...chatMcpConfig,
        servers: chatMcpConfig.servers.filter(
          (server) => !policy || policy.servers.includes(server.name),
        ),
      }
      if (!selectedModel) throw new Error("尚未設定 Pi 驗證，請管理員在私聊使用 /login。")
      const directory = path.join(settings.botSessionLogDir, String(chatId), "durable")
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await chmod(directory, 0o700)
      const sessionFile = path.join(directory, "session.sqlite")
      const registry = createRegistry()
      const nativeTools = [...chatBaseTools]
      const mcp: McpCapability | undefined =
        permittedMcp.servers.length > 0
          ? new McpCapability(
              permittedMcp,
              settings.botWorkdir,
              path.join(directory, "mcp"),
              logger,
              () => {
                if (!mcp) return
                const tools = mcp.tools.filter(allowed).map(guard)
                nativeTools.splice(chatBaseTools.length, nativeTools.length, ...tools)
                registry.install(
                  defineExtension({
                    name: "sumire-mcp",
                    tools: tools.filter((tool) => tool.exposure === "direct").map(adaptTool),
                    sections: [section("mcp_servers", () => mcp?.summary())],
                  }),
                )
              },
              (server, cwd, home) => {
                control?.store.assertChat(chatId)
                if (control && control.store.snapshot().epoch !== state?.epoch)
                  throw new Error("Chat policy changed before MCP startup")
                return createMcpTransport(server, cwd, home)
              },
              (server, tool) => !control || control.store.allowsTool(chatId, tool, server),
            )
          : undefined
      registry.install(
        defineExtension({
          name: "sumire",
          tools: nativeTools.map(adaptTool),
          sections: [section("system", () => systemPrompt, { tag: false })],
        }),
      )
      const assertTool = (name: string) => {
        if (control && !control.store.allowsTool(chatId, name))
          throw new Error("Tool is not allowed")
      }
      if (!control || control.store.allowsTool(chatId, "update_progress"))
        registry.install(createProgressExtension(() => assertTool("update_progress")))
      let harness: Harness | undefined
      let session: DurableSession | undefined
      const codemode = await createDurableCodemode(
        nativeTools,
        Math.round(settings.botCodemodeTimeoutSeconds * 1_000),
        () => {
          if (!harness) throw new Error("Durable harness is not open")
          return harness
        },
        (event) => session?.emit(event),
        (signal) => mcp?.ready(signal) ?? Promise.resolve(),
        () => assertTool("codemode"),
      )
      registry.install({
        ...codemode,
        tools: !control || control.store.allowsTool(chatId, "codemode") ? codemode.tools : [],
      })
      const storage = await openNodeSqliteStorage(sessionFile)
      try {
        await chmod(sessionFile, 0o600)
        control?.store.assertChat(chatId, state?.revision)
        await mcp?.ready()
        control?.store.assertChat(chatId, state?.revision)
        harness = await Harness.open(
          storage,
          {
            models: runtime,
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
            thinkingLevel: policy?.thinking ?? "off",
            cwd: settings.botWorkdir,
          },
        })

        session = await DurableSession.open({
          harness,
          sessionFile,
          cwd: settings.botWorkdir,
          model: selectedModel,
          modelRuntime: runtime,
          registry,
          systemPrompt,
          nativeTools,
          logger,
          trustKey: state
            ? `admin:${state.epoch}`
            : JSON.stringify([...settings.botWhitelist].sort((a, b) => a - b)),
          cleanup: () => mcp?.close() ?? Promise.resolve(),
        })
        if (policy) {
          await session.setModel(selectedModel)
          await session.setThinkingLevel(policy.thinking)
        }
        return session
      } catch (error) {
        try {
          if (harness) await harness.close(context)
          else await storage.close(context)
        } finally {
          await mcp?.close()
        }
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
