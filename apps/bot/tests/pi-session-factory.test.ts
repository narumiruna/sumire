import { cp, mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it, vi } from "vitest"

import { createPiSessionFactory } from "../src/agent/pi-session-factory.js"
import { loadSettings } from "../src/config/settings.js"
import type { Logger } from "../src/logging.js"

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
  it("creates an isolated persistent Pi AgentSession with only approved custom tools", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-pi-"))
    await installInstructions(root)
    const settings = loadSettings(
      {
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: "https://api.example.test/v1",
        OPENAI_MODEL: "test-model",
        BOT_URL_ALLOWED_SCHEMES: "https",
      },
      root,
    )
    const factory = await createPiSessionFactory(settings, logger)
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
      expect(session.getActiveToolNames()).toEqual(["update_progress", "load_public_url"])
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
      expect(
        session.getAllTools().find((tool) => tool.name === "load_public_url")?.sourceInfo.source,
      ).not.toBe("sdk")
      expect(session.systemPrompt).toContain("Telegram 機器人助理")
      expect(session.systemPrompt).toContain("虛構 AI companion")
      expect(session.systemPrompt).not.toContain("{{SOUL_SECTION}}")
      expect(otherSession.sessionFile).toContain(
        path.join(".telegramagent", "sessions", "456", "pi"),
      )
      expect(otherSession.getActiveToolNames()).toEqual(["update_progress", "load_public_url"])
      expect(otherSession.sessionFile).not.toBe(session.sessionFile)
    } finally {
      session.dispose()
      otherSession.dispose()
    }
  })

  it("enables Pi coding tools only for an explicit allowlisted configuration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-pi-tools-"))
    await installInstructions(root)
    await installOtterSkill(root)
    const settings = loadSettings(
      {
        OPENAI_API_KEY: "test-key",
        OPENAI_BASE_URL: "https://api.example.test/v1",
        OPENAI_MODEL: "test-model",
        BOT_CODING_TOOLS_ENABLED: "true",
        BOT_WHITELIST: "123",
      },
      root,
    )
    const factory = await createPiSessionFactory(settings, logger)
    const session = await factory.create(123)

    try {
      expect(session.getActiveToolNames()).toEqual([
        "read",
        "bash",
        "edit",
        "write",
        "update_progress",
        "load_public_url",
      ])
      expect(session.systemPrompt).toContain("<name>load-public-url</name>")
      expect(session.systemPrompt).toContain("<name>otter-manage-expenses</name>")
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("Pi skill diagnostic for chat_id=123"),
      )
    } finally {
      session.dispose()
    }
  })
})
