import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createLogger,
  type LogfireClient,
  redactLogMessage,
  type SpanAttributes,
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
    })
    expect(client.debug).toHaveBeenCalledWith("debug token=[redacted]")
    expect(client.info).toHaveBeenCalledWith("request [redacted] { authorization: '[redacted]' }")
    expect(client.warning).toHaveBeenCalledWith("warning")
    expect(client.error).toHaveBeenCalledWith("failure apiKey=[redacted]")
    expect(client.shutdown).toHaveBeenCalledWith({ timeoutMillis: 5_000 })
    expect(stderr.mock.calls.flat().join(" ")).not.toContain("info-secret")
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

  it("shares a rejected fallback operation with a late SDK callback", async () => {
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
    await expect(delayedCallback?.()).rejects.toBe(failure)
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

  it("falls back to stderr when Logfire configuration fails", () => {
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
