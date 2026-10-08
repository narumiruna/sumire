import { describe, expect, it, vi } from "vitest"

import { loadSettings } from "../src/config/settings.js"
import type { DocumentConverter } from "../src/documents/converter.js"
import { createConfiguredDocumentConverter } from "../src/startup.js"

describe("document converter startup", () => {
  it("does not load the native adapter when document input is disabled", async () => {
    const create = vi.fn()
    const settings = { ...loadSettings({}), botDocumentInputEnabled: false }

    await expect(createConfiguredDocumentConverter(settings, create)).resolves.toBeUndefined()
    expect(create).not.toHaveBeenCalled()
  })

  it("passes runtime limits to the adapter", async () => {
    const converter: DocumentConverter = { convert: vi.fn() }
    const create = vi.fn(async () => converter)
    const settings = {
      ...loadSettings({}),
      botDocumentConversionTimeoutSeconds: 12.5,
      botDocumentMaxMarkdownChars: 1234,
      botDocumentMaxConcurrentConversions: 3,
    }

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
        message: expect.stringContaining("use a supported deployment platform"),
        cause,
      },
    )
  })
})
