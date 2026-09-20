import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

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

describe("createPiSessionFactory", () => {
  it("creates an isolated persistent Pi AgentSession with only approved custom tools", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "telegramagent-pi-"))
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
      await expect(
        urlTool?.execute(
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
})
