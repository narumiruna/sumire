import path from "node:path"

import { describe, expect, it } from "vitest"
import { ZodError } from "zod"

import { loadSettings } from "../src/config/settings.js"

describe("loadSettings", () => {
  it("loads fixed runtime defaults and resolves repository paths", () => {
    const settings = loadSettings({}, "/workspace/project")

    expect(settings.botGroupPassiveContextEnabled).toBe(true)
    expect(settings.botSessionLogDir).toBe(
      path.resolve("/workspace/project/.telegramagent/sessions"),
    )
    expect(settings.botSkillsDir).toBe(path.resolve("/workspace/project/skills"))
    expect(settings.botDocumentMaxBytes).toBe(20_000_000)
    expect(settings.botReplyTreeEnabled).toBe(true)
    expect(settings.botProactivePendingTtlSeconds).toBe(900)
    expect(settings.botUrlContentTimeoutSeconds).toBe(180)
    expect(settings.openaiBaseUrl).toBe("https://api.openai.com/v1")
    expect(settings.morselLongReplyThreshold).toBe(2_000)
  })

  it("parses the supported environment configuration", () => {
    const settings = loadSettings({
      BOT_WHITELIST: "123, -456,123",
      LOGFIRE_TOKEN: "logfire-token",
      MORSEL_URL: "https://morsel.example/",
      OPENAI_BASE_URL: "https://example.test/v1/",
      BOT_DOCUMENT_INPUT_ENABLED: "false",
      BOT_DOCUMENT_MAX_BYTES: "1234",
      BOT_DOCUMENT_MAX_MARKDOWN_CHARS: "4321",
      BOT_DOCUMENT_CONVERSION_TIMEOUT_SECONDS: "2.5",
      BOT_DOCUMENT_MAX_CONCURRENT_CONVERSIONS: "3",
      BOT_REPLY_TREE_ENABLED: "false",
      BOT_REPLY_TREE_MAX_RECORDS_PER_CHAT: "20",
      BOT_REPLY_TREE_MAX_INDEX_BYTES: "2048",
      BOT_PROACTIVE_ENABLED: "false",
      BOT_PROACTIVE_PENDING_TTL_SECONDS: "30",
      BOT_PROACTIVE_PENDING_MAX_CHATS: "40",
      BOT_PROACTIVE_ALLOWED_SCHEMES: "https",
    })

    expect(settings.botWhitelist).toEqual(new Set([123, -456]))
    expect(settings.logfireToken).toBe("logfire-token")
    expect(settings.morselUrl).toBe("https://morsel.example/")
    expect(settings.openaiBaseUrl).toBe("https://example.test/v1")
    expect(settings.botDocumentInputEnabled).toBe(false)
    expect(settings.botDocumentMaxBytes).toBe(1234)
    expect(settings.botDocumentMaxMarkdownChars).toBe(4321)
    expect(settings.botDocumentConversionTimeoutSeconds).toBe(2.5)
    expect(settings.botDocumentMaxConcurrentConversions).toBe(3)
    expect(settings.botReplyTreeEnabled).toBe(false)
    expect(settings.botReplyTreeMaxRecordsPerChat).toBe(20)
    expect(settings.botReplyTreeMaxIndexBytes).toBe(2048)
    expect(settings.botProactiveEnabled).toBe(false)
    expect(settings.botProactivePendingTtlSeconds).toBe(30)
    expect(settings.botProactivePendingMaxChats).toBe(40)
    expect(settings.botProactiveAllowedSchemes).toEqual(new Set(["https"]))
  })

  it("rejects invalid supported settings", () => {
    expect(() => loadSettings({ BOT_WHITELIST: "123,nope" })).toThrow(ZodError)
    expect(() => loadSettings({ MORSEL_URL: "not-a-url" })).toThrow(ZodError)
    expect(() => loadSettings({ BOT_DOCUMENT_INPUT_ENABLED: "yes" })).toThrow(ZodError)
    expect(() => loadSettings({ BOT_DOCUMENT_MAX_BYTES: "0" })).toThrow(ZodError)
    expect(() => loadSettings({ BOT_DOCUMENT_MAX_CONCURRENT_CONVERSIONS: "17" })).toThrow(ZodError)
    expect(() => loadSettings({ BOT_REPLY_TREE_MAX_INDEX_BYTES: "100" })).toThrow(ZodError)
    expect(() => loadSettings({ BOT_PROACTIVE_PENDING_TTL_SECONDS: "0" })).toThrow(ZodError)
    expect(() => loadSettings({ BOT_PROACTIVE_ALLOWED_SCHEMES: "file" })).toThrow(ZodError)
  })
})
