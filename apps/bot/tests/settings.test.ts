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
    expect(settings.botKabigonTimeoutSeconds).toBe(180)
    expect(settings.openaiBaseUrl).toBe("https://api.openai.com/v1")
    expect(settings.morselLongReplyThreshold).toBe(2_000)
  })

  it("parses the supported environment configuration", () => {
    const settings = loadSettings({
      BOT_WHITELIST: "123, -456,123",
      LOGFIRE_TOKEN: "logfire-token",
      MORSEL_URL: "https://morsel.example/",
      OPENAI_BASE_URL: "https://example.test/v1/",
    })

    expect(settings.botWhitelist).toEqual(new Set([123, -456]))
    expect(settings.logfireToken).toBe("logfire-token")
    expect(settings.morselUrl).toBe("https://morsel.example/")
    expect(settings.openaiBaseUrl).toBe("https://example.test/v1")
  })

  it("rejects invalid supported settings", () => {
    expect(() => loadSettings({ BOT_WHITELIST: "123,nope" })).toThrow(ZodError)
    expect(() => loadSettings({ MORSEL_URL: "not-a-url" })).toThrow(ZodError)
  })
})
