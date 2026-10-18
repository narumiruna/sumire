import * as logfire from "@pydantic/logfire-node"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createLogger,
  type LogfireClient,
  redactLogMessage,
  type SpanAttributes,
  safeNodeAutoInstrumentations,
  type TraceSpan,
} from "../src/logging.js"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("redactLogMessage", () => {
  it("redacts Telegram, Firecrawl, bearer, and named secrets", () => {
    const redacted = redactLogMessage(
      "POST https://api.telegram.org/bot123456:secret-token/getMe " +
        "https://mcp.firecrawl.dev/fc-secret/v2/mcp token=abc Authorization=xyz Bearer bearer-secret " +
        "{ apiKey: 'inspect-secret', cookie: \"session-secret\" }",
    )

    expect(redacted).toContain("/bot[redacted]/getMe")
    expect(redacted).toContain("https://mcp.firecrawl.dev/[redacted]/v2/mcp")
    expect(redacted).toContain("token=[redacted]")
    expect(redacted).toContain("Authorization=[redacted]")
    expect(redacted).toContain("Bearer [redacted]")
    expect(redacted).not.toContain("secret-token")
    expect(redacted).not.toContain("fc-secret")
    expect(redacted).not.toContain("bearer-secret")
    expect(redacted).not.toContain("inspect-secret")
    expect(redacted).not.toContain("session-secret")
    expect(redacted).toContain("apiKey: '[redacted]'")
    expect(redacted).toContain('cookie: "[redacted]"')
  })
})

describe("createLogger", () => {
  it("logs braces through the real offline SDK without formatting warnings or secrets", async () => {
    const records: Array<{ name: string; attributes: Record<string, unknown> }> = []
    const client: LogfireClient = {
      ...logfire,
      configure(options) {
        logfire.configure({
          ...options,
          sendToLogfire: false,
          metrics: false,
          variables: false,
          apiKey: "",
          minLevel: null,
          sampling: { head: 1 },
          additionalSpanProcessors: [
            {
              onStart() {},
              onEnd(span) {
                records.push({ name: span.name, attributes: { ...span.attributes } })
              },
              async shutdown() {},
              async forceFlush() {},
            },
          ],
        })
      },
    }
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const logger = createLogger(true, "write-token", client)
    try {
      // Prove this configuration runs the SDK's formatter, not a no-op logger.
      logfire.info("Pipeline check { missing: 1 }")
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("Formatting error:"))
      warning.mockClear()
      records.length = 0

      const message = 'URL failure {source} {{literal}} {} {"phase":"download"}\nnext line'
      const details = { phase: "download", limit: 3_600, nested: { observed: 5_198 } }
      for (const level of ["debug", "info", "warn", "error"] as const) {
        logger[level](message, details)
      }
      logger.info("Failure write-token https://example.test/private?signature=url-secret", {
        token: "named-secret",
        authorization: "Bearer bearer-secret",
        error: new Error("https://example.test/private?signature=error-secret"),
      })

      expect(warning).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
      expect(records).toHaveLength(5)
      expect(records.slice(0, 4).map((record) => record.attributes["logfire.level_num"])).toEqual([
        logfire.Level.Debug,
        logfire.Level.Info,
        logfire.Level.Warning,
        logfire.Level.Error,
      ])
      for (const record of records.slice(0, 4)) {
        expect(record.name).toBe("{message}")
        expect(record.attributes["logfire.msg_template"]).toBe("{message}")
        expect(record.attributes["logfire.msg"]).toBe(record.attributes.message)
        expect(record.attributes.message).toContain(message)
        expect(record.attributes.message).toContain("nested: { observed: 5198 }")
        expect(record.attributes.message).toContain("limit: 3600")
      }
      const local = stderr.mock.calls.flat().join(" ")
      expect(local).toContain(`| INFO | ${message}`)
      expect(local).toContain("nested: { observed: 5198 }")
      const output = JSON.stringify(records) + local
      for (const secret of [
        "write-token",
        "named-secret",
        "bearer-secret",
        "url-secret",
        "error-secret",
        "example.test",
      ]) {
        expect(output).not.toContain(secret)
      }
    } finally {
      await logger.shutdown?.()
    }
  })

  it("exports long startup instructions without truncation and redacts sensitive values", () => {
    const client = createLogfireClient()
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const logger = createLogger(false, "write-token", client)
    const instructions = `${"instruction\n".repeat(2_000)}END apiKey=private-key https://example.test/private`
    logger.info(`Bot instructions loaded\n${instructions}`)

    const exported = vi.mocked(client.info).mock.calls[0]?.[1]?.message
    expect(exported).toContain("instruction\n".repeat(2_000))
    expect(exported).toContain("END apiKey=[redacted] [redacted-url]")
    expect(exported).not.toContain("private-key")
    expect(stderr.mock.calls.flat().join(" ")).not.toContain("private-key")
  })

  it("removes chat approval URL fragments from local and exported logs", async () => {
    const client = createLogfireClient()
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const logger = createLogger(true, "write-token", client)
    const token = "a".repeat(64)
    logger.info(`Approval link https://admin.example.test/#allow=${token}`)
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(token)
    expect(client.info).toHaveBeenCalledWith("{message}", {
      message: "Approval link [redacted-url]",
    })
    await logger.shutdown?.()
  })
  it("configures Logfire and forwards only redacted messages", async () => {
    const client = createLogfireClient()
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const logger = createLogger(true, "write-token", client)

    logger.debug("debug token=debug-secret")
    logger.info("request write-token", { authorization: "Bearer info-secret" })
    logger.warn("warning")
    logger.error("failure apiKey=error-secret")
    await logger.shutdown?.()

    expect(client.configure).toHaveBeenCalledWith({
      token: "write-token",
      serviceName: "sumire",
      console: false,
      nodeAutoInstrumentations: safeNodeAutoInstrumentations,
    })
    expect(client.debug).toHaveBeenCalledWith("{message}", {
      message: "debug token=[redacted]",
    })
    expect(client.info).toHaveBeenCalledWith("{message}", {
      message: "request [redacted] { authorization: '[redacted]' }",
    })
    expect(client.warning).toHaveBeenCalledWith("{message}", { message: "warning" })
    expect(client.error).toHaveBeenCalledWith("{message}", {
      message: "failure apiKey=[redacted]",
    })
    expect(client.shutdown).toHaveBeenCalledWith({ timeoutMillis: 5_000 })
    expect(stderr.mock.calls.flat().join(" ")).not.toContain("info-secret")
  })

  it("omits entire HTTP URLs from stderr and Logfire records when query secrets are unknown", () => {
    const client = createLogfireClient()
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const logger = createLogger(false, "write-token", client)
    logger.warn("Fetch failed at https://example.com/path?signature=unknown-query-secret")

    expect(client.warning).toHaveBeenCalledWith("{message}", {
      message: "Fetch failed at [redacted-url]",
    })
    expect(stderr.mock.calls.flat().join(" ")).not.toContain("unknown-query-secret")
  })

  it("redacts URLs containing an apostrophe without leaving their query suffix", () => {
    const client = createLogfireClient()
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const logger = createLogger(false, "write-token", client)
    logger.warn("Fetch failed at https://example.com/a'b?signature=private-query")

    expect(client.warning).toHaveBeenCalledWith("{message}", {
      message: "Fetch failed at [redacted-url]",
    })
    expect(stderr.mock.calls.flat().join(" ")).not.toContain("private-query")
  })

  it("uses the configured Logfire span with structured metadata", async () => {
    const client = createLogfireClient()
    const recorded: Record<string, string | number | boolean> = {}
    client.span = async <T>(
      _name: string,
      options: { attributes: SpanAttributes; callback: (span: TraceSpan) => Promise<T> },
    ): Promise<T> => {
      Object.assign(recorded, options.attributes)
      return options.callback({
        setAttribute: (key, value) => {
          recorded[key] = value
        },
      })
    }
    const span = vi.spyOn(client, "span")
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const logger = createLogger(false, "write-token", client)
    const result = await logger.span?.("request", { "telegram.message_id": 42 }, async (span) => {
      span.setAttribute("outcome", "delivered")
      return "ok"
    })

    expect(result).toBe("ok")
    expect(span).toHaveBeenCalledOnce()
    expect(recorded).toEqual({ "telegram.message_id": 42, outcome: "delivered" })
  })

  it.each(["throws", "rejects"])(
    "runs an operation without a span when Logfire %s before invoking it",
    async (failure) => {
      const client = createLogfireClient()
      client.span = () => {
        if (failure === "throws") throw new Error("span startup failed")
        return Promise.reject(new Error("span startup failed"))
      }
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
      const logger = createLogger(false, "write-token", client)
      const operation = vi.fn(async () => "delivered")

      await expect(logger.span?.("telegram.request", {}, operation)).resolves.toBe("delivered")
      expect(operation).toHaveBeenCalledOnce()
      expect(stderr.mock.calls.flat().join(" ")).toContain("Logfire span failed")
    },
  )

  it("preserves a completed operation when Logfire rejects after invoking it", async () => {
    const client = createLogfireClient()
    client.span = async (_name, { callback }) => {
      await callback({ setAttribute: () => {} })
      throw new Error("span export failed")
    }
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const logger = createLogger(false, "write-token", client)
    const operation = vi.fn(async (span: TraceSpan) => {
      span.setAttribute("delivery.outcome", "delivered")
      return "delivered"
    })

    await expect(logger.span?.("telegram.deliver", {}, operation)).resolves.toBe("delivered")
    expect(operation).toHaveBeenCalledOnce()
    expect(stderr.mock.calls.flat().join(" ")).toContain("Logfire span failed")
  })

  it("waits for an in-flight operation and ignores attribute failures and early SDK rejection", async () => {
    const client = createLogfireClient()
    client.span = async (_name, { callback }) => {
      void callback({
        setAttribute: () => {
          throw new Error("span attribute failed")
        },
      })
      throw new Error("span export failed")
    }
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const logger = createLogger(false, "write-token", client)
    const operation = vi.fn(async (span: TraceSpan) => {
      await Promise.resolve()
      span.setAttribute("url.outcome", "success")
      return "loaded"
    })

    await expect(logger.span?.("url.load", {}, operation)).resolves.toBe("loaded")
    expect(operation).toHaveBeenCalledOnce()
    expect(stderr.mock.calls.flat().join(" ")).toContain("Logfire span attribute failed")
  })

  it("keeps original operation errors out of Logfire exception events", async () => {
    const client = createLogfireClient()
    const attributes: Record<string, string | number | boolean> = {}
    client.span = async (_name, { callback }) => {
      await expect(
        callback({
          setAttribute: (key, value) => {
            attributes[key] = value
          },
        }),
      ).resolves.toBeUndefined()
      return undefined as never
    }
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const logger = createLogger(false, "write-token", client)
    const failure = new Error("https://example.com/private?signature=synthetic-secret")
    const operation = vi.fn(async () => {
      throw failure
    })

    await expect(logger.span?.("url.load", {}, operation)).rejects.toBe(failure)
    expect(operation).toHaveBeenCalledOnce()
    expect(attributes).toEqual({ "operation.outcome": "error" })
  })

  it("preserves the operation's error rather than a span's replacement error", async () => {
    const client = createLogfireClient()
    client.span = async (_name, { callback }) => {
      try {
        await callback({ setAttribute: () => {} })
      } catch {
        throw new Error("span wrapped the error")
      }
      throw new Error("unreachable")
    }
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const logger = createLogger(false, "write-token", client)
    const failure = new Error("publication failed")
    const operation = vi.fn(async () => {
      throw failure
    })

    await expect(logger.span?.("morsel.publish", {}, operation)).rejects.toBe(failure)
    expect(operation).toHaveBeenCalledOnce()
  })

  it("runs the operation if the SDK resolves without invoking its callback", async () => {
    const client = createLogfireClient()
    client.span = async () => undefined as never
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const logger = createLogger(false, "write-token", client)
    const operation = vi.fn(async () => "ok")

    await expect(logger.span?.("telegram.request", {}, operation)).resolves.toBe("ok")
    expect(operation).toHaveBeenCalledOnce()
  })

  it.each(["resolves", "rejects"])(
    "shares the fallback operation with a late SDK callback when the span %s early",
    async (outcome) => {
      const client = createLogfireClient()
      let delayedCallback: (() => Promise<unknown>) | undefined
      client.span = (_name, { callback }) => {
        delayedCallback = () => callback({ setAttribute: () => {} })
        return outcome === "resolves"
          ? Promise.resolve(undefined as never)
          : Promise.reject(new Error("span export failed"))
      }
      vi.spyOn(process.stderr, "write").mockImplementation(() => true)
      const logger = createLogger(false, "write-token", client)
      const operation = vi.fn(async () => "delivered")

      await expect(logger.span?.("telegram.deliver", {}, operation)).resolves.toBe("delivered")
      await expect(delayedCallback?.()).resolves.toBe("delivered")
      expect(operation).toHaveBeenCalledOnce()
    },
  )

  it("shares a rejected fallback operation with a late SDK callback without leaking the error", async () => {
    const client = createLogfireClient()
    let delayedCallback: (() => Promise<unknown>) | undefined
    client.span = (_name, { callback }) => {
      delayedCallback = () => callback({ setAttribute: () => {} })
      return Promise.reject(new Error("span startup failed"))
    }
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const logger = createLogger(false, "write-token", client)
    const failure = new Error("publication failed")
    const operation = vi.fn(async () => {
      throw failure
    })

    await expect(logger.span?.("morsel.publish", {}, operation)).rejects.toBe(failure)
    await expect(delayedCallback?.()).resolves.toBeUndefined()
    expect(operation).toHaveBeenCalledOnce()
  })

  it("uses stderr only when Logfire is not configured", async () => {
    const client = createLogfireClient()
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const logger = createLogger(false, undefined, client)
    const span = vi.spyOn(client, "span")

    logger.info("local message")

    expect(client.configure).not.toHaveBeenCalled()
    expect(client.info).not.toHaveBeenCalled()
    expect(stderr).toHaveBeenCalledOnce()
    await expect(logger.span?.("ignored", {}, async () => 123)).resolves.toBe(123)
    expect(span).not.toHaveBeenCalled()
  })

  it("falls back to stderr throughout the lifecycle when Logfire configuration fails", async () => {
    const client = createLogfireClient()
    client.configure.mockImplementation(() => {
      throw new Error("invalid configuration")
    })
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const logger = createLogger(false, "write-token", client)

    logger.info("still running")

    expect(client.info).not.toHaveBeenCalled()
    expect(stderr.mock.calls.flat().join(" ")).toContain(
      "Logfire configuration failed; using stderr only",
    )
    expect(stderr.mock.calls.flat().join(" ")).toContain("still running")
    const span = vi.spyOn(client, "span")
    const operation = vi.fn(async () => "delivered")
    await expect(logger.span?.("telegram.deliver", {}, operation)).resolves.toBe("delivered")
    await logger.shutdown?.()
    expect(operation).toHaveBeenCalledOnce()
    expect(span).not.toHaveBeenCalled()
    expect(client.shutdown).not.toHaveBeenCalled()
  })

  it.each([
    ["debug", "debug"],
    ["info", "info"],
    ["warn", "warning"],
    ["error", "error"],
  ] as const)(
    "continues after repeated %s export failures without repeating work",
    async (level, method) => {
      const client = createLogfireClient()
      client[method].mockImplementation(() => {
        throw new Error("write-token https://example.test/private?signature=export-secret")
      })
      client.span = async (_name, { callback }) => {
        await callback({ setAttribute: () => {} })
        throw new Error("span export failed")
      }
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
      const logger = createLogger(true, "write-token", client)
      const operation = vi.fn(async () => {
        logger[level]("URL load complete", { observed: 5_198 })
        logger[level]("Delivery complete", { source: 1 })
        return "delivered"
      })

      await expect(logger.span?.("telegram.deliver", {}, operation)).resolves.toBe("delivered")
      expect(operation).toHaveBeenCalledOnce()
      expect(client[method]).toHaveBeenCalledTimes(2)
      await expect(logger.shutdown?.()).resolves.toBeUndefined()
      expect(client.shutdown).toHaveBeenCalledOnce()
      const output = stderr.mock.calls.flat().join(" ")
      expect(output.match(/Logfire write failed/g)).toHaveLength(2)
      expect(output).toContain("Delivery complete { source: 1 }")
      expect(output).toContain("Logfire span failed")
      expect(output).not.toContain("write-token")
      expect(output).not.toContain("export-secret")
      expect(output).not.toContain("example.test")
    },
  )

  it.each(["throws", "rejects"])("contains shutdown failure when the SDK %s", async (failure) => {
    const client = createLogfireClient()
    client.shutdown.mockImplementation(() => {
      const error = new Error("write-token https://example.test/private?signature=shutdown-secret")
      if (failure === "throws") throw error
      return Promise.reject(error)
    })
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const logger = createLogger(false, "write-token", client)

    logger.debug("hidden")
    logger.info("delivered")
    await expect(logger.shutdown?.()).resolves.toBeUndefined()

    expect(client.debug).not.toHaveBeenCalled()
    expect(client.shutdown).toHaveBeenCalledOnce()
    const output = stderr.mock.calls.flat().join(" ")
    expect(output).toContain("delivered")
    expect(output).toContain("Logfire shutdown failed")
    expect(output).not.toContain("hidden")
    expect(output).not.toContain("write-token")
    expect(output).not.toContain("shutdown-secret")
    expect(output).not.toContain("example.test")
  })
})

function createLogfireClient() {
  return {
    configure: vi.fn<LogfireClient["configure"]>(),
    debug: vi.fn<LogfireClient["debug"]>(),
    info: vi.fn<LogfireClient["info"]>(),
    warning: vi.fn<LogfireClient["warning"]>(),
    error: vi.fn<LogfireClient["error"]>(),
    shutdown: vi.fn<LogfireClient["shutdown"]>(async () => undefined),
    span: async <T>(
      _name: string,
      options: { attributes: SpanAttributes; callback: (span: TraceSpan) => Promise<T> },
    ): Promise<T> => options.callback({ setAttribute: () => {} }),
  } satisfies LogfireClient
}
