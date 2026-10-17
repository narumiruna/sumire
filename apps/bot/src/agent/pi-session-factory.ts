import { createHash } from "node:crypto"
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
import { createPolymarketTools, publicPolymarketToolNames } from "@narumitw/sumire-pi-polymarket"
import { createUrlTool, urlReaderSkillsPath } from "@narumitw/sumire-pi-url-reader"
import { effectivePolicy } from "@narumitw/sumire-policy"
import type { McpAdmin } from "../admin/mcp.js"
import { chatModelRuntime } from "../admin/providers.js"
import { adminShellEnvironment } from "../admin/shell.js"
import type { AdminStore } from "../admin/store.js"
import type { Settings } from "../config/settings.js"
import type { Logger } from "../logging.js"
import { buildMorselTools, createMorselPublisher } from "../morsel.js"
import { ChannelImageIndex } from "../telegram/channel-images.js"
import { createBotUrlLoader } from "../url-loader.js"
import { traceUrlLoad } from "../url-telemetry.js"
import { createDurableCodemode } from "./durable-codemode.js"
import { createProgressExtension } from "./durable-progress.js"
import { DurableSession } from "./durable-session.js"
import { adaptTool, codingTools, collectTools, isCodemodeCallable } from "./durable-tools.js"
import { createMcpTransport, McpCapability } from "./mcp-capability.js"
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
  control: { store: AdminStore; mcp: McpAdmin },
  channelImages = new ChannelImageIndex(settings.botSessionLogDir, logger),
  modelRuntimeOverride?: ModelRuntime,
): Promise<PiSessionFactory> {
  if (!control) throw new Error("Database authorization is required")
  const agentDir = path.join(settings.botSessionLogDir, ".pi-agent")

  const { modelRuntime, login } = await createBotModelRuntime(
    settings,
    agentDir,
    modelRuntimeOverride,
  )
  const loader = new DefaultResourceLoader({
    cwd: settings.botWorkdir,
    agentDir,
    additionalSkillPaths: [settings.botSkillsDir, urlReaderSkillsPath],
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
  const urlTool = createUrlTool(createBotUrlLoader(settings), {
    selectableLoaders: selectableUrlLoaders,
    traceLoad: (url, requestedLoader, toolCallId, load) =>
      traceUrlLoad(logger, url, requestedLoader, toolCallId, load),
  })
  const baseTools = [
    ...codingTools(settings.botWorkdir, adminShellEnvironment(process.env)),
    urlTool,
    ...buildMorselTools(createMorselPublisher(settings), settings.morselMode, logger),
    ...(settings.botChannelImageInputEnabled && settings.botImageInputEnabled
      ? await collectTools(createReadImageExtension(settings, channelImages, logger, control.store))
      : []),
  ]

  const toolNames = [
    ...baseTools.map((tool) => tool.name),
    ...publicPolymarketToolNames,
    "codemode",
    "update_progress",
  ]
  control.store.registerTools(toolNames)
  logger.info(`Bot instructions loaded\n${systemPrompt}`, {
    sha256: createHash("sha256").update(systemPrompt).digest("hex"),
    chars: systemPrompt.length,
    tools: toolNames,
  })

  return {
    login,
    modelRuntime,
    toolNames,

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
      const state = control.store.snapshot()
      control.store.assertChat(chatId, state.revision)
      const policy = effectivePolicy(state.policy, chatId)
      const assertSessionPolicy = () => {
        control.store.assertChat(chatId)
        const latest = control.store.snapshot()
        const current = effectivePolicy(latest.policy, chatId)
        if (
          latest.epoch !== state.epoch ||
          current.model !== policy.model ||
          current.thinking !== policy.thinking
        )
          throw new Error("Chat policy changed before session startup")
      }
      const ref = policy.model
      const requested = ref
        ? modelRuntime.getModel(ref.slice(0, ref.indexOf("/")), ref.slice(ref.indexOf("/") + 1))
        : undefined
      const selectedModel =
        requested &&
        policy.models.includes(`${requested.provider}/${requested.id}`) &&
        (await modelRuntime.checkAuth(requested.provider))
          ? requested
          : undefined
      const runtime = chatModelRuntime(modelRuntime, control.store, chatId)
      const guard = (tool: import("./durable-tools.js").NativeTool) => ({
        ...tool,
        execute: (...args: Parameters<typeof tool.execute>) => {
          control.store.assertChat(chatId)
          if (!control.store.allowsTool(chatId, tool.name)) throw new Error("Tool is not allowed")
          return tool.execute(...args)
        },
      })
      const allowed = (tool: import("./durable-tools.js").NativeTool) =>
        control.store.allowsTool(chatId, tool.name)
      const chatMcpConfig = control.mcp.config()
      const permittedMcp = {
        ...chatMcpConfig,
        servers: chatMcpConfig.servers.filter((server) => policy.servers.includes(server.name)),
      }
      if (!selectedModel) throw new Error("尚未設定 Pi 驗證，請管理員在 Web UI 設定 provider。")
      const directory = path.join(settings.botSessionLogDir, String(chatId), "durable")
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await chmod(directory, 0o700)
      const sessionFile = path.join(directory, "session.sqlite")
      const registry = createRegistry()
      const polymarket = createPolymarketTools()
      const chatBaseTools = [...baseTools, ...polymarket.tools].filter(allowed).map(guard)
      const nativeTools = [...chatBaseTools]
      let mcpTools: import("./durable-tools.js").NativeTool[] = []
      const updateNativeTools = () => {
        nativeTools.splice(0, nativeTools.length, ...chatBaseTools, ...mcpTools)
      }
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
                mcpTools = tools
                updateNativeTools()
                registry.install(
                  defineExtension({
                    name: "sumire-mcp",
                    tools: tools.filter((tool) => tool.exposure === "direct").map(adaptTool),
                    sections: [section("mcp_servers", () => mcp?.summary())],
                  }),
                )
              },
              (server, cwd, home) => {
                control.store.assertChat(chatId)
                if (control.store.snapshot().epoch !== state.epoch)
                  throw new Error("Chat policy changed before MCP startup")
                return createMcpTransport(server, cwd, home)
              },
              (server, tool) => control.store.allowsTool(chatId, tool, server),
              (names) => control.store.registerTools(names),
            )
          : undefined
      const cleanup = async () => {
        await Promise.all([mcp?.close(), polymarket.dispose()])
      }
      registry.install(
        defineExtension({
          name: "sumire",
          tools: chatBaseTools.map(adaptTool),
          sections: [
            section("system", () => systemPrompt, { tag: false }),
            section("tool_access", ({ agent }) => {
              const direct = agent.tools.map((tool) => tool.name)
              const indirect = direct.includes("codemode")
                ? nativeTools
                    .filter(isCodemodeCallable)
                    .map((tool) => tool.name)
                    .filter((name) => !direct.includes(name))
                : []
              return [
                "This chat's current tool access is listed below. Skills and conversation history describe capabilities, not tool authorization.",
                `Direct tools: ${direct.join(", ") || "none"}.`,
                `Additional tools through codemode: ${indirect.join(", ") || "none"}.`,
                "When asked to list tools, report only this chat's current tools. A skill or MCP server is not itself a callable tool.",
                "Use an available tool for the request before claiming it cannot run. Do not ask the user to supply a tool result or infer that the source cannot be read.",
                permittedMcp.servers.length > 0
                  ? [
                      "MCP server access is authorized for this chat. A missing MCP tool can mean a discovery or connection failure, an empty server tool list, or a tool policy limit.",
                      direct.includes("codemode")
                        ? "For a missing MCP tool, use codemode searchTools/describeNamespace once to retry discovery. Only call tools returned by discovery. If the tool is still absent, report that discovery did not provide it and ask the administrator to check the connection and tool policy."
                        : "Codemode is not enabled for this chat. Do not use it for discovery. If an MCP tool is absent, report that it is currently unavailable and ask the administrator to check the connection and tool policy.",
                      "Do not claim that missing discovery results prove missing authorization.",
                    ].join(" ")
                  : "If the required tool is absent, explain that it is not enabled for this chat and ask the administrator to authorize it in the Web UI.",
              ].join("\n")
            }),
          ],
        }),
      )
      const assertTool = (name: string) => {
        if (!control.store.allowsTool(chatId, name)) throw new Error("Tool is not allowed")
      }
      if (control.store.allowsTool(chatId, "update_progress"))
        registry.install(createProgressExtension(() => assertTool("update_progress")))
      let harness: Harness | undefined
      let session: DurableSession | undefined
      let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined
      try {
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
          tools: control.store.allowsTool(chatId, "codemode") ? codemode.tools : [],
        })
        storage = await openNodeSqliteStorage(sessionFile)
        await chmod(sessionFile, 0o600)
        assertSessionPolicy()
        await mcp?.ready()
        assertSessionPolicy()
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
            thinkingLevel: policy.thinking,
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
          trustKey: `admin:${state.epoch}`,
          cleanup,
        })
        await session.setModel(selectedModel)
        await session.setThinkingLevel(policy.thinking)
        logger.info(`Pi chat tool access chat_id=${chatId}`, {
          tools: session.getActiveToolNames(),
          codemodeTools: control.store.allowsTool(chatId, "codemode")
            ? nativeTools.filter(isCodemodeCallable).map((tool) => tool.name)
            : [],
        })
        return session
      } catch (error) {
        try {
          if (harness) await harness.close(context)
          else await storage?.close(context)
        } finally {
          await cleanup()
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
