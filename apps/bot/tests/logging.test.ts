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
