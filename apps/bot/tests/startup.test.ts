import { describe, expect, it, vi } from "vitest"

import { loadSettings } from "../src/config/settings.js"
import type { DocumentConverter } from "../src/documents/converter.js"
import { createConfiguredDocumentConverter } from "../src/startup.js"

describe("document converter startup", () => {
  it("does not load the native adapter when document input is disabled", async () => {
    const create = vi.fn()
    const settings = loadSettings({ BOT_DOCUMENT_INPUT_ENABLED: "false" })

    await expect(createConfiguredDocumentConverter(settings, create)).resolves.toBeUndefined()
    expect(create).not.toHaveBeenCalled()
  })

  it("passes validated limits to the adapter", async () => {
    const converter: DocumentConverter = { convert: vi.fn() }
    const create = vi.fn(async () => converter)
    const settings = loadSettings({
      BOT_DOCUMENT_CONVERSION_TIMEOUT_SECONDS: "12.5",
      BOT_DOCUMENT_MAX_MARKDOWN_CHARS: "1234",
      BOT_DOCUMENT_MAX_CONCURRENT_CONVERSIONS: "3",
    })

    await expect(createConfiguredDocumentConverter(settings, create)).resolves.toBe(converter)
    expect(create).toHaveBeenCalledWith({
      timeoutMs: 12_500,
      maxMarkdownChars: 1_234,
      maxConcurrency: 3,
    })
  })

  it("reports an actionable error when the enabled native adapter cannot load", async () => {
    const cause = new Error("unsupported architecture")
    const create = vi.fn(async () => Promise.reject(cause))

    await expect(createConfiguredDocumentConverter(loadSettings({}), create)).rejects.toMatchObject(
      {
        message: expect.stringContaining("BOT_DOCUMENT_INPUT_ENABLED=false"),
        cause,
      },
    )
  })
})
