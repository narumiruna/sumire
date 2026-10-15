import { readFile } from "node:fs/promises"
import path from "node:path"

import { describe, expect, it } from "vitest"
import { ZodError } from "zod"

import { loadSettings as parseSettings } from "../src/config/settings.js"

const loadSettings = (environment: NodeJS.ProcessEnv = {}, root?: string, workdir?: string) =>
  parseSettings({ BOT_ADMIN_ID: "7", ...environment }, root, workdir)

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
    expect(settings).not.toHaveProperty("botWhitelist")
    expect(settings.botAdminId).toBe(7)
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
    expect(settings).not.toHaveProperty("botWhitelist")
    expect(settings.botAdminId).toBe(123)
    expect(settings.logfireToken).toBe("logfire-token")
    expect(settings.morselApiKey).toBe("morsel-key")
    // Firecrawl and Otter read their credentials directly, not through Bot settings.
    expect(settings).not.toHaveProperty("firecrawlApiKey")
    expect(settings).not.toHaveProperty("otterToken")
  })

  it.each([
    "BOT_WHITELIST",
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

  it("lists only supported bootstrap variables in .env.example", async () => {
    const example = await readFile(new URL("../../../.env.example", import.meta.url), "utf8")
    const names = example
      .split("\n")
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => line.split("=")[0])
    expect(names).toEqual([
      "BOT_TOKEN",
      "BOT_ADMIN_ID",
      "ADMIN_ORIGIN",
      "ADMIN_HOST",
      "ADMIN_PORT",
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

  it("uses localhost for WebUI setup when only BOT_ADMIN_ID is set", () => {
    for (const origin of [undefined, "", "   "]) {
      const settings = loadSettings({ BOT_ADMIN_ID: "42", ADMIN_ORIGIN: origin })
      expect(settings.admin).toMatchObject({
        host: "127.0.0.1",
        port: 17465,
        origin: "http://localhost:17465",
      })
    }
    expect(loadSettings({ BOT_ADMIN_ID: "42", ADMIN_PORT: "17467" }).admin).toMatchObject({
      port: 17467,
      origin: "http://localhost:17467",
    })
    expect(() => loadSettings({ BOT_ADMIN_ID: "42", ADMIN_PORT: "invalid" })).toThrow()
  })

  it("accepts an explicit HTTPS origin with Telegram bootstrap settings", () => {
    const bootstrap = {
      BOT_ADMIN_ID: "42",
      ADMIN_ORIGIN: "https://admin.example.test",
    }
    expect(loadSettings(bootstrap).admin).toMatchObject({
      host: "127.0.0.1",
      port: 17465,
      origin: bootstrap.ADMIN_ORIGIN,
    })
    for (const host of [undefined, "", "   "])
      expect(loadSettings({ ...bootstrap, ADMIN_HOST: host }).admin?.host).toBe("127.0.0.1")
    for (const host of ["0.0.0.0", "::1", "localhost"])
      expect(loadSettings({ ...bootstrap, ADMIN_HOST: ` ${host} ` }).admin?.host).toBe(host)
    expect(loadSettings({}).admin.origin).toBe("http://localhost:17465")
    for (const origin of [
      "http://admin.example.test",
      "https://admin.example.test/",
      "https://user:pass@admin.example.test",
    ])
      expect(() => loadSettings({ ...bootstrap, ADMIN_ORIGIN: origin })).toThrow()
    expect(() => loadSettings({ ...bootstrap, BOT_ADMIN_ID: "" })).toThrow()
    expect(() => loadSettings({ ...bootstrap, ADMIN_PORT: "0" })).toThrow()
  })

  it.each(["", " ", "invalid", "0", "65536"])("rejects invalid admin port %j", (port) => {
    expect(() => loadSettings({ ADMIN_PORT: port })).toThrow()
  })

  it.each([undefined, "", "  "])(
    "requires an administrator even with obsolete access settings: %j",
    (id) => {
      expect(() => parseSettings({ BOT_ADMIN_ID: id, BOT_WHITELIST: "7,-100" })).toThrow(
        "BOT_ADMIN_ID is required",
      )
    },
  )

  it("rejects invalid supported settings", () => {
    expect(loadSettings({ BOT_WHITELIST: "123,nope" })).toEqual(loadSettings({}))
    for (const id of ["0", "-123", "1.5", "1e3", "abc", "9007199254740992"]) {
      expect(() => loadSettings({ BOT_ADMIN_ID: id })).toThrow(ZodError)
    }
    expect(() => loadSettings({ BOT_ADMIN_ID: "" })).toThrow("BOT_ADMIN_ID is required")
    expect(() => loadSettings({ BOT_ADMIN_ID: "  " })).toThrow("BOT_ADMIN_ID is required")
    expect(loadSettings({ LOGFIRE_TOKEN: " ", MORSEL_API_KEY: " " }).logfireToken).toBeUndefined()
    expect(loadSettings({ LOGFIRE_TOKEN: " ", MORSEL_API_KEY: " " }).morselApiKey).toBeUndefined()
    expect(loadSettings({}, "relative").projectRoot).toBe(path.resolve("relative"))
  })
})
