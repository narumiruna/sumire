import { readFile } from "node:fs/promises"
import path from "node:path"

import { describe, expect, it } from "vitest"
import { ZodError } from "zod"

import { loadSettings } from "../src/config/settings.js"

describe("loadSettings", () => {
  it("loads fixed runtime defaults and resolves repository paths", () => {
    const settings = loadSettings({}, "/workspace/project")
    expect(settings).toMatchObject({
      projectRoot: "/workspace/project",
      botWorkdir: "/workspace/project",
      botMcpConfigPath: "/workspace/project/mcp.json",
      botCodemodeTimeoutSeconds: 300,
      botGroupPassiveContextEnabled: true,
      botDocumentInputEnabled: true,
      botDocumentMaxBytes: 20_000_000,
      botDocumentMaxMarkdownChars: 50_000,
      botDocumentConversionTimeoutSeconds: 30,
      botDocumentMaxConcurrentConversions: 2,
      botReplyTreeEnabled: true,
      botReplyTreeMaxRecordsPerChat: 1_000,
      botReplyTreeMaxIndexBytes: 1_000_000,
      botUrlTimeoutSeconds: 15,
      botUrlContentTimeoutSeconds: 180,
      botUrlMaxExtractedChars: 12_000,
      botImageInputEnabled: true,
      botChannelImageInputEnabled: true,
      botImageMaxBytes: 8_000_000,
      botAudioInputEnabled: true,
      botAudioMaxBytes: 20_000_000,
      botAudioMaxDurationSeconds: 600,
      botAudioTranscriptionTimeoutSeconds: 180,
      botAudioMaxTranscriptChars: 12_000,
      morselUrl: "https://morsel.narumi.dev/",
      morselLongReplyThreshold: 1_000,
    })
    expect(settings.botWhitelist).toEqual(new Set())
    expect(settings.botAdminId).toBeUndefined()
    expect(settings.botSessionLogDir).toBe("/workspace/project/.telegramagent/sessions")
    expect(settings.botSkillsDir).toBe("/workspace/project/skills")
    expect(settings.botSystemPromptPath).toBe("/workspace/project/instructions/SYSTEM.md")
    expect(settings.botSoulPath).toBe("/workspace/project/instructions/SOUL.md")
    expect(settings.botUrlAllowedSchemes).toEqual(new Set(["http", "https"]))
  })

  it("parses retained credentials and Telegram authorization", () => {
    const settings = loadSettings({
      BOT_TOKEN: "test-token",
      BOT_WHITELIST: "123, -456,123",
      BOT_ADMIN_ID: "123",
      FIRECRAWL_API_KEY: "firecrawl-key",
      OTTER_TOKEN: "otter-token",
      LOGFIRE_TOKEN: " logfire-token ",
      MORSEL_API_KEY: " morsel-key ",
    })
    expect(settings.botToken).toBe("test-token")
    expect(settings.botWhitelist).toEqual(new Set([123, -456]))
    expect(settings.botAdminId).toBe(123)
    expect(settings.logfireToken).toBe("logfire-token")
    expect(settings.morselApiKey).toBe("morsel-key")
    // Firecrawl and Otter read their credentials directly, not through Bot settings.
    expect(settings).not.toHaveProperty("firecrawlApiKey")
    expect(settings).not.toHaveProperty("otterToken")
  })

  it.each([
    "BOT_WORKDIR",
    "BOT_MCP_CONFIG_PATH",
    "BOT_CODEMODE_ENABLED",
    "BOT_CODEMODE_TIMEOUT_SECONDS",
    "BOT_DOCUMENT_INPUT_ENABLED",
    "BOT_DOCUMENT_MAX_BYTES",
    "BOT_DOCUMENT_MAX_MARKDOWN_CHARS",
    "BOT_DOCUMENT_CONVERSION_TIMEOUT_SECONDS",
    "BOT_DOCUMENT_MAX_CONCURRENT_CONVERSIONS",
    "BOT_REPLY_TREE_ENABLED",
    "BOT_REPLY_TREE_MAX_RECORDS_PER_CHAT",
    "BOT_REPLY_TREE_MAX_INDEX_BYTES",
    "BOT_URL_TIMEOUT_SECONDS",
    "BOT_URL_CONTENT_TIMEOUT_SECONDS",
    "BOT_URL_MAX_EXTRACTED_CHARS",
    "BOT_URL_ALLOWED_SCHEMES",
    "BOT_IMAGE_INPUT_ENABLED",
    "BOT_CHANNEL_IMAGE_INPUT_ENABLED",
    "BOT_IMAGE_MAX_BYTES",
    "BOT_AUDIO_INPUT_ENABLED",
    "BOT_AUDIO_MAX_BYTES",
    "BOT_AUDIO_MAX_DURATION_SECONDS",
    "BOT_AUDIO_TRANSCRIPTION_TIMEOUT_SECONDS",
    "BOT_AUDIO_MAX_TRANSCRIPT_CHARS",
    "MORSEL_URL",
    "BOT_URL_FIRECRAWL_FALLBACK_ENABLED",
  ])("ignores removed environment setting %s", (name) => {
    for (const value of ["false", "invalid", "0", "/other/path"]) {
      expect(loadSettings({ [name]: value })).toEqual(loadSettings({}))
    }
  })

  it("keeps Docker workdir separate from application-owned resources", () => {
    const settings = loadSettings({}, "/app", "/workdir")
    expect(settings.botWorkdir).toBe("/workdir")
    expect(settings.botMcpConfigPath).toBe("/app/mcp.json")
    expect(settings.botSessionLogDir).toBe("/app/.telegramagent/sessions")
    expect(settings.botSystemPromptPath).toBe("/app/instructions/SYSTEM.md")
  })

  it("lists only the seven retained variables in .env.example", async () => {
    const example = await readFile(new URL("../../../.env.example", import.meta.url), "utf8")
    const names = example
      .split("\n")
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => line.split("=")[0])
    expect(names).toEqual([
      "BOT_TOKEN",
      "BOT_WHITELIST",
      "BOT_ADMIN_ID",
      "FIRECRAWL_API_KEY",
      "OTTER_TOKEN",
      "LOGFIRE_TOKEN",
      "MORSEL_API_KEY",
    ])
  })

  it.each([
    {
      OPENAI_MODEL: "not-a-real-model",
      OPENAI_BASE_URL: "not-a-url",
      OPENAI_API_KEY: "ignored-key",
    },
    { OPENAI_MODEL: "", OPENAI_BASE_URL: "", OPENAI_API_KEY: "" },
  ])("does not parse OpenAI configuration owned by Pi: %j", (environment) => {
    expect(loadSettings(environment)).toEqual(loadSettings({}))
  })

  it("rejects invalid supported settings", () => {
    expect(() => loadSettings({ BOT_WHITELIST: "123,nope" })).toThrow(ZodError)
    for (const id of ["0", "-123", "1.5", "1e3", "abc", "9007199254740992"]) {
      expect(() => loadSettings({ BOT_ADMIN_ID: id })).toThrow(ZodError)
    }
    expect(loadSettings({ BOT_ADMIN_ID: "" }).botAdminId).toBeUndefined()
    expect(loadSettings({ BOT_ADMIN_ID: "  " }).botAdminId).toBeUndefined()
    expect(loadSettings({ LOGFIRE_TOKEN: " ", MORSEL_API_KEY: " " }).logfireToken).toBeUndefined()
    expect(loadSettings({ LOGFIRE_TOKEN: " ", MORSEL_API_KEY: " " }).morselApiKey).toBeUndefined()
    expect(loadSettings({}, "relative").projectRoot).toBe(path.resolve("relative"))
  })
})
