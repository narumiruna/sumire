import { describe, expect, it, vi } from "vitest"

import { loadSettings } from "../src/config/settings.js"
import type { DocumentConverter } from "../src/documents/converter.js"
import type { Logger } from "../src/logging.js"
import {
  closeApplicationResources,
  createConfiguredDocumentConverter,
  runApplicationLifecycle,
} from "../src/startup.js"

describe("application cleanup", () => {
  it("closes every named resource in order and preserves all failures", async () => {
    const order: string[] = []
    const httpError = new Error("http fixture")
    const databaseError = new Error("database fixture")
    const logger = fixtureLogger()
    await expect(
      closeApplicationResources(
        [
          {
            name: "http",
            close: async () => {
              order.push("http")
              throw httpError
            },
          },
          {
            name: "sessions",
            close: async () => {
              order.push("sessions")
            },
          },
          {
            name: "database",
            close: () => {
              order.push("database")
              throw databaseError
            },
          },
        ],
        logger,
      ),
    ).rejects.toMatchObject({
      message: "Application cleanup failed",
      errors: [httpError, databaseError],
    })
    expect(order).toEqual(["http", "sessions", "database"])
    expect(logger.error).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenNthCalledWith(1, "Application resource cleanup failed", {
      "event.name": "application.resource.failed",
      "application.resource": "http",
      error: httpError,
    })
    expect(logger.error).toHaveBeenNthCalledWith(2, "Application resource cleanup failed", {
      "event.name": "application.resource.failed",
      "application.resource": "database",
      error: databaseError,
    })
  })
})

function fixtureLogger(events: string[] = []) {
  return {
    debug: vi.fn(),
    info: vi.fn((message: string) => {
      events.push(`info:${message}`)
    }),
    warn: vi.fn(),
    error: vi.fn((message: string, _details?: unknown) => {
      events.push(`error:${message}`)
    }),
    shutdown: vi.fn(async () => {
      events.push("logging closed")
    }),
  } satisfies Logger
}

describe("application logging lifecycle", () => {
  it("records the original startup failure before resource cleanup and final export", async () => {
    const events: string[] = []
    const logger = fixtureLogger(events)
    const failure = new Error("startup fixture")
    const run = vi.fn(async () => {
      events.push("startup")
      throw failure
    })
    const close = vi.fn(async () => {
      events.push("resources closed")
    })

    await expect(runApplicationLifecycle(logger, run, close)).rejects.toBe(failure)
    expect(events).toEqual([
      "info:Starting application",
      "startup",
      "error:Application failed",
      "resources closed",
      "logging closed",
    ])
    expect(logger.error).toHaveBeenCalledExactlyOnceWith("Application failed", {
      "event.name": "application.failed",
      error: failure,
    })
    expect(logger.shutdown).toHaveBeenCalledOnce()
  })

  it("does not replace a startup error when cleanup also fails", async () => {
    const events: string[] = []
    const logger = fixtureLogger(events)
    const original = new Error("startup fixture")
    const cleanup = new Error("cleanup fixture")

    await expect(
      runApplicationLifecycle(
        logger,
        async () => {
          throw original
        },
        async () => {
          throw cleanup
        },
      ),
    ).rejects.toBe(original)
    expect(logger.error).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenLastCalledWith("Application cleanup failed", {
      "event.name": "application.cleanup.failed",
      error: cleanup,
    })
    expect(events.at(-1)).toBe("logging closed")
  })

  it("reports a cleanup-only failure before closing logging", async () => {
    const logger = fixtureLogger()
    const failure = new Error("cleanup fixture")
    await expect(
      runApplicationLifecycle(
        logger,
        async () => {},
        async () => {
          throw failure
        },
      ),
    ).rejects.toBe(failure)
    expect(logger.error).toHaveBeenCalledExactlyOnceWith("Application cleanup failed", {
      "event.name": "application.cleanup.failed",
      error: failure,
    })
    expect(logger.shutdown).toHaveBeenCalledOnce()
  })

  it("keeps logging available while resources drain", async () => {
    const events: string[] = []
    const logger = fixtureLogger(events)
    let finishDrain = () => {}
    const drain = new Promise<void>((resolve) => {
      finishDrain = resolve
    })
    const close = vi.fn(async () => {
      events.push("drain started")
      await drain
      logger.info("Drain completed")
    })
    const running = runApplicationLifecycle(logger, async () => {}, close)
    try {
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
      expect(logger.shutdown).not.toHaveBeenCalled()
    } finally {
      finishDrain()
      await running
    }
    expect(events).toEqual([
      "info:Starting application",
      "drain started",
      "info:Drain completed",
      "info:Application stopped",
      "logging closed",
    ])
  })

  it("contains custom telemetry shutdown errors without replacing application results", async () => {
    const logger = fixtureLogger()
    logger.shutdown.mockRejectedValueOnce(new Error("telemetry fixture"))
    await expect(
      runApplicationLifecycle(
        logger,
        async () => {},
        async () => {},
      ),
    ).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledOnce()
  })

  it("preserves even a non-Error startup rejection", async () => {
    const logger = fixtureLogger()
    await expect(
      runApplicationLifecycle(
        logger,
        async () => {
          throw undefined
        },
        async () => {},
      ),
    ).rejects.toBeUndefined()
    expect(logger.shutdown).toHaveBeenCalledOnce()
  })
})

describe("document converter startup", () => {
  it("does not load the native adapter when document input is disabled", async () => {
    const create = vi.fn()
    const settings = { ...loadSettings({ BOT_ADMIN_ID: "7" }), botDocumentInputEnabled: false }

    await expect(createConfiguredDocumentConverter(settings, create)).resolves.toBeUndefined()
    expect(create).not.toHaveBeenCalled()
  })

  it("passes runtime limits to the adapter", async () => {
    const converter: DocumentConverter = { convert: vi.fn() }
    const create = vi.fn(async () => converter)
    const settings = {
      ...loadSettings({ BOT_ADMIN_ID: "7" }),
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

    await expect(
      createConfiguredDocumentConverter(loadSettings({ BOT_ADMIN_ID: "7" }), create),
    ).rejects.toMatchObject({
      message: expect.stringContaining("use a supported deployment platform"),
      cause,
    })
  })
})
