import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { createPublicUrlLoader } from "@narumitw/sumire-url-tool"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { DurableSession } from "../src/agent/durable-session.js"
import { createPiSessionFactory } from "../src/agent/pi-session-factory.js"
import { asSessionCreator, ChatSessionRegistry } from "../src/agent/session-registry.js"
import { loadSettings } from "../src/config/settings.js"
import type { Logger, SpanAttributes } from "../src/logging.js"
import { urlFingerprint } from "../src/url-telemetry.js"
import { appendMessage, currentConversation } from "./helpers/durable-session.js"

vi.mock("@narumitw/sumire-url-tool", { spy: true })

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
        BOT_WHITELIST: "7",
        BOT_ADMIN_ID: "7",
      },
      root,
    )
    const factory = await createPiSessionFactory(settings, logger)
    expect(factory.login).toBeDefined()
    await expect(factory.create(7)).rejects.toThrow("請管理員在私聊使用 /login")
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
      expect(first.modelRuntime).toBe(second.modelRuntime)
      expect(first.messages).toEqual([])
    } finally {
      await first.dispose()
      await second.dispose()
    }
  })

  it.each(["", "7"])("bootstraps non-OpenAI Pi credentials with admin=%s", async (adminId) => {
    vi.stubEnv("OPENAI_API_KEY", "")
    const root = await mkdtemp(path.join(tmpdir(), "sumire-pi-provider-fallback-"))
    await installInstructions(root)
    const settings = loadSettings({ BOT_WHITELIST: "7", BOT_ADMIN_ID: adminId }, root)
    const authPath = path.join(settings.botSessionLogDir, ".pi-agent/auth.json")
    await mkdir(path.dirname(authPath), { recursive: true })
    await writeFile(
      authPath,
      JSON.stringify({ anthropic: { type: "api_key", key: "fixture-key" } }),
      {
        mode: 0o600,
      },
    )
    const factory = await createPiSessionFactory(settings, logger)
    const registry = new ChatSessionRegistry(
      asSessionCreator(factory),
      settings.botSessionLogDir,
      logger,
    )
    try {
      const choices = await registry.getModelSettings(7)
      expect(choices.currentModel).toMatch(/^anthropic\//u)
      expect(choices.models.length).toBeGreaterThan(1)
      expect(choices.models.every((reference) => reference.startsWith("anthropic/"))).toBe(true)
      const alternative = choices.models.find((reference) => reference !== choices.currentModel)
      if (!alternative) throw new Error("Missing alternative Anthropic model")
      await expect(registry.setModel(7, alternative)).resolves.toMatchObject({
        currentModel: alternative,
      })
      await registry.reset(7)
      await expect(registry.getModelSettings(7)).resolves.toMatchObject({
        currentModel: choices.currentModel,
      })

      // Pi discovering OpenAI credentials later restores the preferred default for new chats.
      vi.stubEnv("OPENAI_API_KEY", "fixture-openai-key")
      await expect(registry.getModelSettings(8)).resolves.toMatchObject({
        currentModel: "openai/gpt-5.6-luna",
        thinkingLevel: "off",
      })
      await expect(registry.setModel(7, "openai/gpt-5.6-luna")).resolves.toMatchObject({
        currentModel: "openai/gpt-5.6-luna",
      })
    } finally {
      await registry.dispose()
    }
  })

  it("uses Pi-owned credentials before login and switches existing sessions to shared OAuth after login", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sumire-pi-auth-"))
    await installInstructions(root)
    const settings = loadSettings({ BOT_WHITELIST: "7", BOT_ADMIN_ID: "7" }, root)
    const factory = await createPiSessionFactory(settings, logger)
    const first = await factory.create(7)
    try {
      const model = first.model
      if (!model) throw new Error("Missing OpenAI model")
      expect(factory.login).toBeDefined()
      expect(model).toMatchObject({ provider: "openai", api: "openai-responses" })
      expect(await first.modelRuntime.getAuth(model)).toMatchObject({
        auth: { apiKey: "fixture-key" },
      })
      const provider = first.modelRuntime.getProvider("openai")
      if (!provider?.auth.oauth || !factory.login) throw new Error("Missing OAuth provider")
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
      await factory.login.login({ prompt: vi.fn(), notify: vi.fn() })
      expect(await first.modelRuntime.getAuth(model)).toMatchObject({
        auth: { apiKey: "fixture-access" },
        source: "OAuth",
      })
      const second = await factory.create(8)
      try {
        expect(second.modelRuntime).toBe(first.modelRuntime)
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
    const settings = loadSettings({ BOT_WHITELIST: "7" }, root)
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
      await first.setModel(alternative)
      await first.setThinkingLevel("high")
      expect(first.thinkingLevel).toBe("high")
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
      expect(other.thinkingLevel).toBe("off")
      expect(other.messages).toEqual([])
    } finally {
      await resumed.dispose()
      await other.dispose()
    }
    const registry = new ChatSessionRegistry(
      asSessionCreator(restartedFactory),
      settings.botSessionLogDir,
      logger,
    )
    try {
      await registry.reset(7)
      await expect(registry.getModelSettings(7)).resolves.toMatchObject({
        currentModel: `${defaultModel?.provider}/${defaultModel?.id}`,
        thinkingLevel: "off",
      })
    } finally {
      await registry.dispose()
    }
  })

  it("falls back to the initial model when a saved model is no longer available", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sumire-pi-model-fallback-"))
    await installInstructions(root)
    const settings = loadSettings({ BOT_WHITELIST: "7" }, root)
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
      expect(resumed.model).toMatchObject({ provider: "openai", id: "gpt-5.6-luna" })
      expect(resumed.messages).toContainEqual(expect.objectContaining({ role: "user" }))
    } finally {
      await resumed.dispose()
    }
  })

  it("rejects an empty whitelist before enabling coding tools", async () => {
    const settings = loadSettings({})

    await expect(createPiSessionFactory(settings, logger)).rejects.toThrow(
      "BOT_WHITELIST must contain a trusted Telegram user or chat ID for coding tools",
    )
  })

  it("closes storage after initialization fails and allows a clean reopen", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sumire-durable-startup-"))
    await installInstructions(root)
    const factory = await createPiSessionFactory(
      loadSettings({ OPENAI_API_KEY: "test-key", BOT_WHITELIST: "123" }, root),
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
    const settings = loadSettings(
      {
        BOT_URL_ALLOWED_SCHEMES: "https",
        BOT_WHITELIST: "123",
      },
      root,
    )
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
        id: "gpt-5.6-luna",
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
        "load_public_url",
        "update_progress",
        "codemode",
      ])
      expect(session.getActiveToolNames()).toContain("codemode")
      const urlTool = session.nativeTools.find((tool) => tool.name === "load_public_url")
      expect(urlTool).toBeDefined()
      if (!urlTool) throw new Error("load_public_url was not registered")
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
      ).rejects.toThrow("URL scheme is not allowed: http")
      expect(spans).toEqual([
        {
          name: "url.load",
          attributes: {
            "url.fingerprint": urlFingerprint("http://8.8.8.8/"),
            "url.requested_loader": "auto",
            "pi.tool_call_id": "url-call",
            "url.outcome": "error",
            "url.error_type": "Error",
          },
        },
      ])
      expect(JSON.stringify(spans)).not.toContain("http://8.8.8.8/")
      expect(
        session.registry
          .snapshot()
          .tools()
          .find(({ tool }) => tool.name === "load_public_url")?.tool.replay,
      ).toBe("unsafe")
      expect(session.systemPrompt).toContain("Telegram 機器人助理")
      expect(session.systemPrompt).toContain("<name>load-url-content</name>")
      expect(session.systemPrompt).toContain(
        "使用者只提供網址時，先以 load_public_url 讀取本則訊息的網址",
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
    ]) {
      const settings = loadSettings(
        {
          BOT_WHITELIST: "123,-100",
          BOT_CHANNEL_IMAGE_INPUT_ENABLED: String(channelEnabled),
          BOT_IMAGE_INPUT_ENABLED: String(imageEnabled),
        },
        root,
      )
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
    const settings = loadSettings(
      {
        BOT_WORKDIR: "workdir",
        BOT_WHITELIST: "123",
      },
      root,
    )
    const factory = await createPiSessionFactory(settings, logger)
    const session = await factory.create(123)

    try {
      expect(session.sessionManager.getCwd()).toBe(workdir)
      expect(session.getActiveToolNames()).toEqual([
        "read",
        "bash",
        "edit",
        "write",
        "load_public_url",
        "update_progress",
        "codemode",
      ])
      for (const name of ["read", "bash", "edit", "write"]) {
        expect(session.nativeTools.find((tool) => tool.name === name)).toBeDefined()
      }
      const write = session.nativeTools.find((tool) => tool.name === "write")
      const edit = session.nativeTools.find((tool) => tool.name === "edit")
      const read = session.nativeTools.find((tool) => tool.name === "read")
      const bash = session.nativeTools.find((tool) => tool.name === "bash")
      if (!write || !edit || !read || !bash) throw new Error("Pi coding tools were not registered")

      await write.execute(
        "write-call",
        { path: "scratch/note.txt", content: "before\n" },
        undefined,
        undefined,
        undefined as never,
      )
      await edit.execute(
        "edit-call",
        { path: "scratch/note.txt", edits: [{ oldText: "before", newText: "after" }] },
        undefined,
        undefined,
        undefined as never,
      )
      const readResult = await read.execute(
        "read-call",
        { path: "scratch/note.txt" },
        undefined,
        undefined,
        undefined as never,
      )
      expect(readResult.content).toContainEqual({ type: "text", text: "after\n" })
      expect(existsSync(path.join(workdir, "scratch/note.txt"))).toBe(true)
      expect(existsSync(path.join(root, "scratch/note.txt"))).toBe(false)
      const bashResult = await bash.execute(
        "bash-call",
        { command: "test -f scratch/note.txt && printf tool-ok", timeout: 5 },
        undefined,
        undefined,
        undefined as never,
      )
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

    const settings = loadSettings({ BOT_WORKDIR: workdir, BOT_WHITELIST: "123" }, root)
    const factory = await createPiSessionFactory(settings, logger)
    const session = await factory.create(123)
    try {
      expect(session.sessionManager.getCwd()).toBe(workdir)
      expect(session.sessionManager.getSessionId()).not.toBe(oldSession.getSessionId())
      expect(session.sessionManager.getSessionFile()).not.toBe(oldFile)
      expect(oldFile && existsSync(oldFile)).toBe(true)
    } finally {
      await session.dispose()
    }
  })
})
