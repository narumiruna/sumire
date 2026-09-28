import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { SessionManager } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"

import { createPiSessionFactory } from "../src/agent/pi-session-factory.js"
import { loadSettings } from "../src/config/settings.js"
import type { Logger, SpanAttributes } from "../src/logging.js"
import { urlFingerprint } from "../src/url-telemetry.js"

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
}

async function installOtterSkill(projectRoot: string): Promise<void> {
  const skillsDir = path.join(projectRoot, "skills")
  await mkdir(skillsDir, { recursive: true })
  await cp(otterSkillSource, path.join(skillsDir, "otter-manage-expenses"), { recursive: true })
}

describe("createPiSessionFactory", () => {
  it("rejects an empty whitelist before enabling coding tools", async () => {
    const settings = loadSettings({ OPENAI_API_KEY: "test-key" })

    await expect(createPiSessionFactory(settings, logger)).rejects.toThrow(
      "BOT_WHITELIST must contain a trusted Telegram user or chat ID for coding tools",
    )
  })

  it("creates isolated persistent Pi AgentSessions with native tools by default", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-pi-"))
    await installInstructions(root)
    const settings = loadSettings(
      {
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: "https://api.example.test/v1",
        OPENAI_MODEL: "test-model",
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
    const session = await factory.create(123)
    const otherSession = await factory.create(456)

    try {
      expect(session.model).toMatchObject({
        provider: "telegramagent-openai",
        id: "test-model",
        contextWindow: 100_000,
        maxTokens: 20_000,
      })
      expect(session.sessionFile).toContain(path.join(".telegramagent", "sessions", "123", "pi"))
      expect(session.getActiveToolNames()).toEqual([
        "read",
        "bash",
        "edit",
        "write",
        "update_progress",
        "load_public_url",
      ])
      const urlTool = session.getToolDefinition("load_public_url")
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
        session.getAllTools().find((tool) => tool.name === "load_public_url")?.sourceInfo.source,
      ).not.toBe("sdk")
      expect(session.systemPrompt).toContain("Telegram 機器人助理")
      expect(session.systemPrompt).toContain("<name>load-url-content</name>")
      expect(session.systemPrompt).toContain(
        "使用者只提供網址時，先以 load_public_url 讀取本則訊息的網址",
      )
      expect(session.systemPrompt).toContain("虛構 AI companion")
      expect(session.systemPrompt).not.toContain("{{SOUL_SECTION}}")
      expect(otherSession.sessionFile).toContain(
        path.join(".telegramagent", "sessions", "456", "pi"),
      )
      expect(otherSession.getActiveToolNames()).toEqual(session.getActiveToolNames())
      expect(otherSession.sessionFile).not.toBe(session.sessionFile)
    } finally {
      session.dispose()
      otherSession.dispose()
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
          OPENAI_API_KEY: "test-key",
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
          const tool = session.getToolDefinition("read_image")
          expect(tool).toBeDefined()
          const result = await tool?.execute("list", {}, undefined, undefined, undefined as never)
          expect(result?.content[0]).toMatchObject({
            type: "text",
            text: expect.stringContaining("No indexed channel images"),
          })
        }
      } finally {
        session.dispose()
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
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: "https://api.example.test/v1",
        OPENAI_MODEL: "test-model",
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
        "update_progress",
        "load_public_url",
      ])
      for (const name of ["read", "bash", "edit", "write"]) {
        expect(session.getAllTools().find((tool) => tool.name === name)?.sourceInfo.source).toBe(
          "builtin",
        )
      }
      const write = session.getToolDefinition("write")
      const edit = session.getToolDefinition("edit")
      const read = session.getToolDefinition("read")
      const bash = session.getToolDefinition("bash")
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
      session.dispose()
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

    const settings = loadSettings(
      { BOT_WORKDIR: workdir, BOT_WHITELIST: "123", OPENAI_API_KEY: "test-key" },
      root,
    )
    const factory = await createPiSessionFactory(settings, logger)
    const session = await factory.create(123)
    try {
      expect(session.sessionManager.getCwd()).toBe(workdir)
      expect(session.sessionManager.getSessionId()).not.toBe(oldSession.getSessionId())
      expect(session.sessionManager.getSessionFile()).not.toBe(oldFile)
      expect(oldFile && existsSync(oldFile)).toBe(true)
    } finally {
      session.dispose()
    }
  })
})
