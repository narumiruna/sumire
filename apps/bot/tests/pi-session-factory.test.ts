import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { publicPolymarketToolNames } from "@narumitw/sumire-pi-polymarket"
import { createPublicUrlLoader } from "@narumitw/sumire-pi-url-reader"
import { inherited } from "@narumitw/sumire-policy"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProviderAdmin } from "../src/admin/providers.js"
import { DurableSession } from "../src/agent/durable/session.js"
import { createPiSessionFactory as createProductionFactory } from "../src/agent/pi-session-factory.js"
import { asSessionCreator, ChatSessionRegistry } from "../src/agent/session-registry.js"
import { loadSettings } from "../src/config/settings.js"
import type { Logger, SpanAttributes } from "../src/logging.js"
import { urlFingerprint } from "../src/url-telemetry.js"
import { appendMessage, callDurableTool, currentConversation } from "./helpers/durable-session.js"
import { createTestSessionFactory as createPiSessionFactory } from "./helpers/session-factory.js"

vi.mock("@narumitw/sumire-pi-url-reader", { spy: true })

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const instructionsSource = path.join(repositoryRoot, "instructions")
const otterSkillSource = path.join(repositoryRoot, "skills/otter-manage-expenses")

async function installInstructions(projectRoot: string): Promise<void> {
  await cp(instructionsSource, path.join(projectRoot, "instructions"), { recursive: true })
  await writeFile(path.join(projectRoot, "mcp.json"), JSON.stringify({ mcpServers: {} }))
}

async function installOtterSkill(projectRoot: string): Promise<void> {
  const skillsDir = path.join(projectRoot, "skills")
  await mkdir(skillsDir, { recursive: true })
  await cp(otterSkillSource, path.join(skillsDir, "otter-manage-expenses"), { recursive: true })
}

describe("createPiSessionFactory", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-key")
    vi.stubEnv("HF_TOKEN", "")
  })
  afterEach(() => vi.unstubAllEnvs())

  it("bootstraps OAuth without a key and shares stored native auth across chat sessions", async () => {
    vi.stubEnv("OPENAI_API_KEY", "")
    const root = await mkdtemp(path.join(tmpdir(), "sumire-pi-oauth-"))
    await installInstructions(root)
    const settings = loadSettings(
      {
        BOT_ADMIN_ID: "7",
      },
      root,
    )
    const factory = await createPiSessionFactory(settings, logger)
    await expect(factory.create(7)).rejects.toThrow("請管理員在 Web UI 設定 provider")
    const authPath = path.join(settings.botSessionLogDir, ".pi-agent/auth.json")
    await mkdir(path.dirname(authPath), { recursive: true })
    await writeFile(
      authPath,
      JSON.stringify({
        openai: {
          type: "oauth",
          access: "fixture-access",
          refresh: "fixture-refresh",
          expires: Date.now() + 3_600_000,
        },
      }),
      { mode: 0o600 },
    )
    const first = await factory.create(7)
    const second = await factory.create(8)
    try {
      expect(first.model).toMatchObject({ provider: "openai", api: "openai-responses" })
      expect(second.model).toMatchObject({ provider: "openai", api: "openai-responses" })
      expect(await first.modelRuntime.getAuth("openai")).toEqual(
        await second.modelRuntime.getAuth("openai"),
      )
      expect(first.messages).toEqual([])
      expect(factory.toolNames).not.toContain("miyu_cna_news")
      expect(first.getActiveToolNames()).not.toContain("miyu_cna_news")
      expect(first.nativeTools.map((tool) => tool.name)).not.toContain("miyu_cna_news")
    } finally {
      await first.dispose()
      await second.dispose()
    }
  })

  it("requires explicit policy selection instead of falling back to newly available credentials", async () => {
    vi.stubEnv("OPENAI_API_KEY", "")
    const root = await mkdtemp(path.join(tmpdir(), "sumire-pi-provider-policy-"))
    await installInstructions(root)
    const settings = loadSettings({ BOT_ADMIN_ID: "7" }, root)
    const authPath = path.join(settings.botSessionLogDir, ".pi-agent/auth.json")
    await mkdir(path.dirname(authPath), { recursive: true })
    await writeFile(
      authPath,
      JSON.stringify({ anthropic: { type: "api_key", key: "fixture-key" } }),
      { mode: 0o600 },
    )
    const factory = await createPiSessionFactory(settings, logger)
    await expect(factory.create(7)).rejects.toThrow("請管理員在 Web UI 設定 provider")
    const state = factory.control.snapshot()
    const selected = state.policy.models.find((ref) => ref.startsWith("anthropic/"))
    if (!selected) throw new Error("Missing fixture Anthropic model")
    state.policy.defaults.model = selected
    factory.control.save(state.policy, state.revision, "7")
    factory.control.applied(state.revision + 1, true)
    const registry = new ChatSessionRegistry(
      asSessionCreator(factory),
      settings.botSessionLogDir,
      logger,
      { control: factory.control },
    )
    try {
      for (const chatId of [7, 8]) {
        if (chatId === 8) vi.stubEnv("OPENAI_API_KEY", "fixture-openai-key")
        const session = await factory.create(chatId)
        try {
          expect(`${session.model?.provider}/${session.model?.id}`).toBe(selected)
        } finally {
          await session.dispose()
        }
      }
      const updated = factory.control.snapshot()
      updated.policy.chats["7"] = { ...inherited, enabled: true, model: "openai/gpt-6.1-sol" }
      factory.control.save(updated.policy, updated.revision, "7")
      await registry.invalidatePolicies()
      factory.control.applied(updated.revision + 1, true)
      await registry.reset(7)
      const reset = await factory.create(7)
      try {
        expect(reset.model).toMatchObject({ provider: "openai", id: "gpt-6.1-sol" })
      } finally {
        await reset.dispose()
      }
    } finally {
      await registry.dispose()
    }
  })

  it("uses Pi-owned credentials before login and switches existing sessions to shared OAuth after login", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sumire-pi-auth-"))
    await installInstructions(root)
    const settings = loadSettings({ BOT_ADMIN_ID: "7" }, root)
    const factory = await createPiSessionFactory(settings, logger)
    const first = await factory.create(7)
    try {
      const model = first.model
      if (!model) throw new Error("Missing OpenAI model")
      expect(model).toMatchObject({ provider: "openai", api: "openai-responses" })
      expect(await first.modelRuntime.getAuth(model)).toMatchObject({
        auth: { apiKey: "fixture-key" },
      })
      const provider = first.modelRuntime.getProvider("openai")
      if (!provider?.auth.oauth || !factory.modelRuntime) throw new Error("Missing OAuth provider")
      first.modelRuntime.registerNativeProvider({
        ...provider,
        auth: {
          ...provider.auth,
          oauth: {
            ...provider.auth.oauth,
            login: async () => ({
              type: "oauth",
              access: "fixture-access",
              refresh: "fixture-refresh",
              expires: Date.now() + 3_600_000,
            }),
          },
        },
      })
      const admin = new ProviderAdmin(factory.modelRuntime, factory.control)
      const login = admin.loginState(admin.startLogin("openai", "7"), "7")
      await login.done
      expect(login.status).toBe("completed")
      expect(await first.modelRuntime.getAuth(model)).toMatchObject({
        auth: { apiKey: "fixture-access" },
        source: "OAuth",
      })
      const second = await factory.create(8)
      try {
        expect(await second.modelRuntime.getAuth("openai")).toEqual(
          await first.modelRuntime.getAuth("openai"),
        )
        expect(await second.modelRuntime.checkAuth("openai")).toMatchObject({ type: "oauth" })
      } finally {
        await second.dispose()
      }
    } finally {
      await first.dispose()
    }
  })

  it("restores a chat's model and thinking after restart without changing defaults in other chats", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sumire-pi-model-persistence-"))
    await installInstructions(root)
    const settings = loadSettings({ BOT_ADMIN_ID: "7" }, root)
    const factory = await createPiSessionFactory(settings, logger)
    const first = await factory.create(7)
    const defaultModel = first.model
    const alternative = first.modelRuntime
      .getModels("openai")
      .find((model) => model.reasoning && model.id !== defaultModel?.id)
    if (!alternative) throw new Error("Missing alternative reasoning model")
    try {
      await appendMessage(first, {
        role: "user",
        content: "fixture conversation",
        timestamp: Date.now(),
      })
      const state = factory.control.snapshot()
      state.policy.chats["7"] = {
        ...inherited,
        enabled: true,
        model: `${alternative.provider}/${alternative.id}`,
        thinking: "high",
      }
      factory.control.save(state.policy, state.revision, "7")
      factory.control.applied(state.revision + 1, true)
    } finally {
      await first.dispose()
    }
    const restartedFactory = await createPiSessionFactory(settings, logger)
    const resumed = await restartedFactory.create(7)
    const other = await restartedFactory.create(8)
    try {
      expect(resumed.model).toMatchObject({ provider: alternative.provider, id: alternative.id })
      expect(resumed.thinkingLevel).toBe("high")
      expect(resumed.messages).toContainEqual(
        expect.objectContaining({ role: "user", content: "fixture conversation" }),
      )
      expect(other.model).toMatchObject({ provider: defaultModel?.provider, id: defaultModel?.id })
      expect(other.thinkingLevel).toBe("low")
      expect(other.messages).toEqual([])
    } finally {
      await resumed.dispose()
      await other.dispose()
    }
    const registry = new ChatSessionRegistry(
      asSessionCreator(restartedFactory),
      settings.botSessionLogDir,
      logger,
      { control: restartedFactory.control },
    )
    try {
      await registry.reset(7)
      const reset = await restartedFactory.create(7)
      try {
        expect(reset.model).toMatchObject({ provider: alternative.provider, id: alternative.id })
        expect(reset.thinkingLevel).toBe("high")
        expect(reset.messages).toEqual([])
      } finally {
        await reset.dispose()
      }
    } finally {
      await registry.dispose()
    }
  })

  it("falls back to the initial model when a saved model is no longer available", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sumire-pi-model-fallback-"))
    await installInstructions(root)
    const settings = loadSettings({ BOT_ADMIN_ID: "7" }, root)
    const factory = await createPiSessionFactory(settings, logger)
    const first = await factory.create(7)
    try {
      await appendMessage(first, {
        role: "user",
        content: "fixture conversation",
        timestamp: Date.now(),
      })
      await (await currentConversation(first)).configure(
        { model: { provider: "unavailable", modelId: "missing" } },
        context,
      )
    } finally {
      await first.dispose()
    }
    const resumed = await factory.create(7)
    try {
      expect(resumed.model).toMatchObject({ provider: "openai", id: "gpt-6.1-sol" })
      expect(resumed.messages).toContainEqual(expect.objectContaining({ role: "user" }))
    } finally {
      await resumed.dispose()
    }
  })

  it("rejects a missing database authorization dependency before enabling tools", async () => {
    const settings = loadSettings({ BOT_ADMIN_ID: "7" })
    await expect(createProductionFactory(settings, logger, undefined as never)).rejects.toThrow(
      "Database authorization is required",
    )
  })

  it("closes storage after initialization fails and allows a clean reopen", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sumire-durable-startup-"))
    await installInstructions(root)
    const factory = await createPiSessionFactory(
      loadSettings({ BOT_ADMIN_ID: "7", OPENAI_API_KEY: "test-key" }, root),
      logger,
    )
    const open = vi
      .spyOn(DurableSession, "open")
      .mockRejectedValueOnce(new Error("startup fixture failed"))
    try {
      await expect(factory.create(123)).rejects.toThrow("startup fixture failed")
      expect(logger.error).toHaveBeenCalledWith(
        "Durable session initialization failed for chat_id=123",
        expect.any(Error),
      )
      const reopened = await factory.create(123)
      await reopened.dispose()
    } finally {
      open.mockRestore()
    }
  })

  it("creates isolated persistent Durable sessions with native tools by default", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-pi-"))
    await installInstructions(root)
    const settings = {
      ...loadSettings({ BOT_ADMIN_ID: "7" }, root),
      botUrlAllowedSchemes: new Set(["https"]),
    }
    const spans: Array<{ name: string; attributes: SpanAttributes }> = []
    const tracedLogger: Logger = {
      ...logger,
      span: async (name, attributes, callback) => {
        const record = { name, attributes: { ...attributes } }
        spans.push(record)
        return callback({
          setAttribute: (key, value) => {
            record.attributes[key] = value
          },
        })
      },
    }
    const factory = await createPiSessionFactory(settings, tracedLogger)
    expect(createPublicUrlLoader).toHaveBeenLastCalledWith(
      expect.objectContaining({ firecrawlFallback: true }),
    )
    const session = await factory.create(123)
    const otherSession = await factory.create(456)

    try {
      expect(session.model).toMatchObject({
        provider: "openai",
        id: "gpt-6.1-sol",
        api: "openai-responses",
      })
      expect(session.sessionFile).toContain(
        path.join(".telegramagent", "sessions", "123", "durable"),
      )
      expect(session.getActiveToolNames()).toEqual([
        "read",
        "bash",
        "edit",
        "write",
        "read_url_content",
        "read_variable",
        "publish_markdown_to_morsel",
        "read_image",
        ...publicPolymarketToolNames,
        "update_progress",
        "codemode",
      ])
      expect(session.getActiveToolNames()).not.toContain("read_github_notifications")
      expect(session.getActiveToolNames()).toContain("codemode")
      const urlTool = session.nativeTools.find((tool) => tool.name === "read_url_content")
      expect(urlTool).toBeDefined()
      if (!urlTool) throw new Error("read_url_content was not registered")
      expect(
        (
          urlTool.parameters as unknown as {
            properties: { loader: { enum: string[] } }
          }
        ).properties.loader.enum,
      ).toEqual(["built-in", "httpx", "curl-cffi", "playwright", "firecrawl"])
      await expect(
        urlTool.execute(
          "url-call",
          { url: "http://8.8.8.8/" },
          undefined,
          undefined,
          undefined as never,
        ),
      ).resolves.toMatchObject({ isError: true, details: { code: "unsafe_url" } })
      expect(spans).toEqual([
        {
          name: "url.load",
          attributes: {
            "url.fingerprint": urlFingerprint("http://8.8.8.8/"),
            "url.requested_loader": "auto",
            "pi.tool_call_id": "url-call",
            "url.outcome": "error",
            "url.error_code": "unsafe_url",
            "url.diagnostic": JSON.stringify({ code: "unsafe_url", phase: "validation" }),
          },
        },
      ])
      expect(JSON.stringify(spans)).not.toContain("http://8.8.8.8/")
      expect(
        session.registry
          .snapshot()
          .tools()
          .find(({ tool }) => tool.name === "read_url_content")?.tool.replay,
      ).toBe("unsafe")
      const instructionsLog = vi
        .mocked(logger.info)
        .mock.calls.findLast(([message]) => message.startsWith("Bot instructions loaded\n"))
      const basePrompt = instructionsLog?.[0].slice("Bot instructions loaded\n".length) ?? ""
      expect(basePrompt).toContain("Telegram 機器人助理")
      expect(basePrompt).not.toContain("<available_skills>")
      expect(session.systemPrompt).toContain(basePrompt)
      expect(instructionsLog?.[1]).toEqual({
        sha256: createHash("sha256").update(basePrompt).digest("hex"),
        chars: basePrompt.length,
        tools: factory.toolNames,
      })
      expect(session.systemPrompt).toContain("Telegram 機器人助理")
      expect(session.systemPrompt).toContain("<name>load-url-content</name>")
      expect(session.systemPrompt).toContain(
        "使用者只提供網址時，先以 read_url_content 讀取本則訊息的網址",
      )
      expect(session.systemPrompt).toContain("虛構 AI companion")
      expect(session.systemPrompt).not.toContain("{{SOUL_SECTION}}")
      expect(otherSession.sessionFile).toContain(
        path.join(".telegramagent", "sessions", "456", "durable"),
      )
      expect(otherSession.getActiveToolNames()).toEqual(session.getActiveToolNames())
      expect(otherSession.sessionFile).not.toBe(session.sessionFile)
    } finally {
      await session.dispose()
      await otherSession.dispose()
    }
  })

  it("registers read_image only when both channel and image input are enabled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-channel-tool-"))
    await installInstructions(root)
    for (const [channelEnabled, imageEnabled] of [
      [true, true],
      [true, false],
      [false, true],
    ] as const) {
      const settings = {
        ...loadSettings({ BOT_ADMIN_ID: "7" }, root),
        botChannelImageInputEnabled: channelEnabled,
        botImageInputEnabled: imageEnabled,
      }
      const factory = await createPiSessionFactory(settings, logger)
      const session = await factory.create(123)
      try {
        const enabled = channelEnabled && imageEnabled
        expect(session.getActiveToolNames().includes("read_image")).toBe(enabled)
        if (enabled) {
          const tool = session.nativeTools.find((tool) => tool.name === "read_image")
          expect(tool).toBeDefined()
          const result = await tool?.execute("list", {}, undefined, undefined, undefined as never)
          expect(result?.content[0]).toMatchObject({
            type: "text",
            text: expect.stringContaining("No indexed channel images"),
          })
        }
      } finally {
        await session.dispose()
      }
    }
  })

  it("executes Pi coding tools from a separate workdir while loading root skills", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-pi-tools-"))
    const workdir = path.join(root, "workdir")
    await mkdir(workdir)
    await installInstructions(root)
    await installOtterSkill(root)
    const settings = {
      ...loadSettings({ BOT_ADMIN_ID: "7" }, root),
      botWorkdir: path.resolve(root, "workdir"),
    }
    const factory = await createPiSessionFactory(settings, logger)
    const session = await factory.create(123)

    try {
      expect(session.cwd).toBe(workdir)
      expect(session.getActiveToolNames()).toEqual([
        "read",
        "bash",
        "edit",
        "write",
        "read_url_content",
        "read_variable",
        "publish_markdown_to_morsel",
        "read_image",
        ...publicPolymarketToolNames,
        "update_progress",
        "codemode",
      ])
      for (const name of ["read", "bash", "edit", "write"]) {
        expect(
          session.registry
            .snapshot()
            .tools()
            .find(({ tool }) => tool.name === name),
        ).toBeDefined()
      }
      await callDurableTool(session, "write", { path: "scratch/note.txt", content: "before\n" })
      await callDurableTool(session, "edit", {
        path: "scratch/note.txt",
        edits: [{ oldText: "before", newText: "after" }],
      })
      const readResult = await callDurableTool(session, "read", { path: "scratch/note.txt" })
      expect(readResult.content).toContainEqual({ type: "text", text: "after\n" })
      expect(existsSync(path.join(workdir, "scratch/note.txt"))).toBe(true)
      expect(existsSync(path.join(root, "scratch/note.txt"))).toBe(false)
      const bashResult = await callDurableTool(session, "bash", {
        command: "test -f scratch/note.txt && printf tool-ok",
        timeout: 5,
      })
      expect(bashResult.content).toContainEqual({ type: "text", text: "tool-ok" })

      expect(session.systemPrompt).toContain("<name>load-public-url</name>")
      expect(session.systemPrompt.match(/<name>load-url-content<\/name>/g)).toHaveLength(1)
      expect(session.systemPrompt).toContain("<name>otter-manage-expenses</name>")
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("Pi skill diagnostic for chat_id=123"),
      )
    } finally {
      await session.dispose()
    }
  })

  it("starts a new session when the stored session used the old cwd", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-pi-migration-"))
    const workdir = path.join(root, "workdir")
    await mkdir(workdir)
    await installInstructions(root)
    const sessionDirectory = path.join(root, ".telegramagent/sessions/123/pi")
    const oldSession = SessionManager.create(root, sessionDirectory)
    oldSession.appendMessage({ role: "user", content: "old conversation", timestamp: Date.now() })
    oldSession.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "old answer" }],
      api: "openai-completions",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    })
    const oldFile = oldSession.getSessionFile()

    const settings = {
      ...loadSettings({ BOT_ADMIN_ID: "7" }, root),
      botWorkdir: path.resolve(root, workdir),
    }
    const factory = await createPiSessionFactory(settings, logger)
    const session = await factory.create(123)
    try {
      expect(session.cwd).toBe(workdir)
      expect(session.sessionId).not.toBe(oldSession.getSessionId())
      expect(session.sessionFile).not.toBe(oldFile)
      expect(oldFile && existsSync(oldFile)).toBe(true)
    } finally {
      await session.dispose()
    }
  })
})
