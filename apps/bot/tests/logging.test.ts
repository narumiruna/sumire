import { SpanStatusCode } from "@opentelemetry/api"
import { HttpError } from "grammy"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createLogger,
  errorAttributes,
  type LogfireClient,
  redactLogMessage,
  type SpanAttributes,
  safeNodeAutoInstrumentations,
  setSpanError,
  type TraceSpan,
  withLogSpan,
} from "../src/logging.js"
import { createLocalDiagnostics } from "../src/logging-runtime.js"

const loggers: ReturnType<typeof createLogger>[] = []
afterEach(async () => {
  for (const logger of loggers.splice(0)) await logger.shutdown?.()
  vi.restoreAllMocks()
})

function setup(verbose = true, token: string | undefined = "write-token") {
  const client = {
    configure: vi.fn<LogfireClient["configure"]>(),
    debug: vi.fn<LogfireClient["debug"]>(),
    info: vi.fn<LogfireClient["info"]>(),
    warning: vi.fn<LogfireClient["warning"]>(),
    error: vi.fn<LogfireClient["error"]>(),
    shutdown: vi.fn<LogfireClient["shutdown"]>(async () => {}),
    span: async <T>(
      _name: string,
      options: { attributes: SpanAttributes; callback: (span: TraceSpan) => Promise<T> },
    ) => options.callback({ setAttribute() {}, setStatus() {} }),
  } satisfies LogfireClient
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  const logger = createLogger(verbose, token, client)
  loggers.push(logger)
  return { client, logger, stderr, output: () => stderr.mock.calls.flat().join(" ") }
}

describe("safe metadata", () => {
  it("removes complete URLs, credentials, bearer values and Telegram tokens", () => {
    const output = redactLogMessage(
      "https://api.telegram.org/bot123456:secret-token/getMe " +
        "https://mcp.firecrawl.dev/fc-secret/v2/mcp https://example.test/a'b?signature=query-secret " +
        "token=abc Authorization=xyz Bearer bearer-secret { apiKey: 'inspect-secret', Cookie: \"cookie-secret\" }",
    )
    for (const secret of [
      "secret-token",
      "fc-secret",
      "example.test",
      "query-secret",
      "abc",
      "xyz",
      "bearer-secret",
      "inspect-secret",
      "cookie-secret",
    ]) {
      expect(output).not.toContain(secret)
    }
    expect(redactLogMessage("apiKey: 'inspect-secret'")).toBe("apiKey: '[redacted]'")
    expect(redactLogMessage('Cookie: "cookie-secret"')).toBe("Cookie=[redacted]")
    expect(redactLogMessage("Authorization: Basic private-basic-value")).not.toContain(
      "private-basic-value",
    )
    expect(redactLogMessage("Cookie: first=private-first; second=private-second")).not.toContain(
      "private-",
    )
    expect(redactLogMessage("bot123456:private-bare-token")).toBe("[redacted]")
  })

  it("projects bounded error causes and never inspects messages, stacks or payloads", () => {
    const error = Object.assign(new Error("private-response"), {
      name: "GrammyError",
      error_code: 400,
      method: "sendMessage",
      payload: { text: "private-body", file_id: "private-file" },
      cause: Object.assign(new Error("https://private.test/?token=private-token"), {
        code: "ECONNRESET",
      }),
    })
    Object.assign(error.cause, { cause: error })
    expect(errorAttributes(error)).toEqual({
      "error.type": "GrammyError",
      "http.response.status_code": 400,
      "http.request.method": "sendMessage",
      "error.cause.1.type": "Error",
      "error.cause.1.code": "ECONNRESET",
    })
    const hostile = {
      get name() {
        throw new Error("private-name")
      },
      get message() {
        throw new Error("must not read")
      },
      toJSON() {
        throw new Error("must not serialize")
      },
    }
    expect(errorAttributes(hostile)).toEqual({ "error.type": "unknown" })
    expect(errorAttributes({ name: "/private/error/path" })).toEqual({ "error.type": "unknown" })
    let nested: Error = new Error("deep")
    for (let index = 0; index < 100; index++) nested = new Error("deep", { cause: nested })
    expect(Object.keys(errorAttributes(nested))).toHaveLength(4)
  })

  it("marks real errors but not normal cancellation, and supports old span mocks", () => {
    const setAttribute = vi.fn()
    const setStatus = vi.fn()
    setSpanError(
      { setAttribute, setStatus },
      Object.assign(new Error("secret"), { code: "ETIMEDOUT" }),
    )
    expect(setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR })
    expect(setAttribute).toHaveBeenCalledWith("logfire.level_num", 17)
    expect(setAttribute).toHaveBeenCalledWith("error.code", "ETIMEDOUT")
    setAttribute.mockClear()
    setStatus.mockClear()
    const abort = new DOMException("cancelled secret", "AbortError")
    const wrapped = new HttpError("private wrapper", new Error("private cause", { cause: abort }))
    setSpanError({ setAttribute, setStatus }, wrapped)
    expect(setStatus).not.toHaveBeenCalled()
    expect(setAttribute.mock.calls).toEqual([["operation.outcome", "cancelled"]])
    expect(errorAttributes(wrapped)).toEqual({
      "error.type": "HttpError",
      "error.cause.1.type": "Error",
      "error.cause.2.type": "AbortError",
      "error.cause.2.code": 20,
    })
    const cyclic = new HttpError("private cycle", undefined)
    Object.assign(cyclic, { error: cyclic })
    setSpanError({ setAttribute, setStatus }, cyclic)
    expect(setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR })
    expect(() => setSpanError({ setAttribute() {} })).not.toThrow()
    expect(() =>
      setSpanError({
        setAttribute() {
          throw new Error("SDK failure")
        },
      }),
    ).not.toThrow()
  })

  it("bounds diagnostics per time window, resets after 60 seconds, and prevents recursion", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0)
    const records: string[] = []
    const diagnose = createLocalDiagnostics((event) => {
      records.push(event)
      diagnose("recursive-diagnostic")
    })
    for (let count = 0; count < 30; count++)
      diagnose("telemetry.sdk.error", new Error("private-body"))
    expect(records).toHaveLength(11)
    expect(records.at(-1)).toBe("telemetry.diagnostics.suppressed")
    now.mockReturnValue(59_999)
    diagnose("suppressed")
    expect(records).toHaveLength(11)
    now.mockReturnValue(60_000)
    diagnose("telemetry.sdk.warning")
    expect(records).toHaveLength(12)
    expect(records.at(-1)).toBe("telemetry.sdk.warning")
  })

  it("uses a no-op span with an absent logger", async () => {
    await expect(
      withLogSpan(undefined, "app.work", {}, async (span) => {
        span.setAttribute("private.body", "ignored")
        setSpanError(span)
        return 42
      }),
    ).resolves.toBe(42)
  })
})

describe("logging boundary", () => {
  it("keeps typed correlation and normal policy words without exporting bodies or arbitrary details", () => {
    const { logger, client, output } = setup()
    logger.info("Pi session created; API key and Cookie policy {literal}", {
      "event.name": "pi.session.created",
      "telegram.chat_id": 42,
      "pi.session_id": "session_id-real-123",
      "pi.attempt": 2,
      "pi.success": false,
      "application.resource": "sessions",
      "application.signal": "SIGTERM",
      text: "private-body",
      file_id: "private-file",
      payload: { text: "private-payload" },
      token: "private-token",
      unknown: "private-unknown",
      nested: { source: "private-nested" },
    })
    expect(client.info).toHaveBeenCalledWith("{sumire_message}", {
      "event.name": "pi.session.created",
      "telegram.chat_id": 42,
      "pi.session_id": "session_id-real-123",
      "pi.attempt": 2,
      "pi.success": false,
      "application.resource": "sessions",
      "application.signal": "SIGTERM",
      sumire_message: "Pi session created; API key and Cookie policy {literal}",
    })
    expect(output()).not.toContain("private-")
    expect(client.configure).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeAutoInstrumentations: safeNodeAutoInstrumentations,
        scrubbing: { safeKeys: expect.arrayContaining(["sumire_message", "pi.session_id"]) },
      }),
    )
  })

  it("bounds tool arrays and reprojects serialized URL diagnostics instead of forwarding raw JSON", async () => {
    const { logger, client, output } = setup()
    logger.info("Tools configured", {
      "pi.tools": [
        ...Array.from({ length: 40 }, (_, index) => `tool_${index}`),
        "private-overflow",
      ],
      "pi.codemode_tools": ["read_url", "https://private.test", { text: "private-object" }],
    })
    expect(client.info.mock.calls[0]?.[1]?.["pi.tools"]).toHaveLength(32)
    expect(client.info.mock.calls[0]?.[1]?.["pi.codemode_tools"]).toEqual([
      "read_url",
      "[redacted-url]",
    ])
    const attributes: SpanAttributes = {}
    client.span = async (_name, options) => {
      Object.assign(attributes, options.attributes)
      return options.callback({
        setAttribute: (key, value) => {
          attributes[key] = value
        },
      })
    }
    const diagnostic = {
      code: "transport_failure",
      phase: "loading",
      httpStatus: 503,
      message: "private-diagnostic-message",
      url: "https://private.test/?token=private-diagnostic-token",
    }
    await logger.span?.(
      "url.load",
      {
        "url.attempts": JSON.stringify([
          { loaderId: "built-in", status: "failed", diagnostic, payload: "private-payload" },
        ]),
        "url.diagnostic": JSON.stringify(diagnostic),
      },
      async (span) => {
        span.setAttribute("url.diagnostic", JSON.stringify(diagnostic))
      },
    )
    expect(attributes["url.diagnostic"]).toBe(
      JSON.stringify({ code: "transport_failure", phase: "loading", httpStatus: 503 }),
    )
    expect(JSON.stringify(attributes) + output()).not.toContain("private-")
  })

  it("omits multiline startup bodies, caps summaries, and redacts all accepted metadata", async () => {
    const { logger, client, output } = setup()
    logger.info("Bot instructions loaded\nprivate-instruction-body", {
      "pi.instructions_chars": 200,
    })
    logger.warn("Failure write-token https://private.test/a'b?signature=private-query", {
      "pi.session_id": "https://private.test/?secret=private-session",
      "pi.tool_name": "write-token",
      error: Object.assign(new Error("private-error-body"), {
        name: "GrammyError",
        error_code: 400,
        method: "sendMessage",
        payload: { text: "private-response-body" },
      }),
    })
    logger.info("x".repeat(2_000))
    expect(client.info.mock.calls[0]?.[1]).toMatchObject({
      sumire_message: "Bot instructions loaded",
      "pi.instructions_chars": 200,
    })
    expect(client.info.mock.calls[1]?.[1]?.sumire_message).toHaveLength(1_024)
    expect(JSON.stringify(client.warning.mock.calls) + output()).not.toContain("private-")
    expect(output()).not.toContain("write-token")
    await logger.shutdown?.()
    await logger.shutdown?.()
    expect(client.shutdown).toHaveBeenCalledOnce()
  })

  it("projects initial span attributes, mutations, status and span names", async () => {
    const { client, logger } = setup()
    const recorded: SpanAttributes = {}
    const setStatus = vi.fn()
    const names: string[] = []
    client.span = async (name, { attributes, callback }) => {
      names.push(name)
      Object.assign(recorded, attributes)
      return callback({
        setAttribute: (key, value) => {
          recorded[key] = value
        },
        setStatus,
      })
    }
    await logger.span?.(
      "https://private.test/?token=private-name",
      {
        "telegram.chat_id": 42,
        "pi.session_id": "session_id-123",
        "request.body": "private-body",
      },
      async (span) => {
        span.setAttribute("payload", "private-payload")
        span.setAttribute("pi.tool_name", "https://private.test/?secret=private-tool")
        span.setAttribute("delivery.outcome", "delivered")
        span.setStatus?.({ code: SpanStatusCode.ERROR, message: "private-status" })
      },
    )
    expect(names).toEqual(["app.operation"])
    expect(recorded).toEqual({
      "telegram.chat_id": 42,
      "pi.session_id": "session_id-123",
      "delivery.outcome": "delivered",
    })
    expect(setStatus).toHaveBeenCalledWith({ code: SpanStatusCode.ERROR })
  })

  it.each(["throws", "rejects", "never-calls", "fails-after", "fails-during"])(
    "does not repeat work when the SDK %s",
    async (failure) => {
      const { client, logger } = setup()
      client.span = (_name, { callback }) => {
        if (failure === "throws") throw new Error("private-sdk")
        if (failure === "rejects") return Promise.reject(new Error("private-sdk"))
        if (failure === "never-calls") return Promise.resolve(undefined as never)
        const operation = callback({
          setAttribute() {
            throw new Error("private-attribute")
          },
        })
        if (failure === "fails-during") {
          void operation
          return Promise.reject(new Error("private-sdk"))
        }
        return operation.then(() => {
          throw new Error("private-sdk")
        })
      }
      const operation = vi.fn(async (span: TraceSpan) => {
        await Promise.resolve()
        span.setAttribute("delivery.outcome", "delivered")
        return "delivered"
      })
      await expect(logger.span?.("telegram.deliver", {}, operation)).resolves.toBe("delivered")
      expect(operation).toHaveBeenCalledOnce()
    },
  )

  it.each([true, false])(
    "shares an operation with late SDK callbacks (failure=%s)",
    async (fails) => {
      const { client, logger } = setup()
      let late: (() => Promise<unknown>) | undefined
      client.span = (_name, { callback }) => {
        late = () => callback({ setAttribute() {} })
        return Promise.reject(new Error("SDK unavailable"))
      }
      const error = new Error("private-operation")
      const operation = vi.fn(async () => {
        if (fails) throw error
        return "ok"
      })
      const pending = logger.span?.("telegram.deliver", {}, operation)
      if (fails) await expect(pending).rejects.toBe(error)
      else await expect(pending).resolves.toBe("ok")
      await expect(late?.()).resolves.toBe(fails ? undefined : "ok")
      expect(operation).toHaveBeenCalledOnce()
    },
  )

  it("contains SDK write/shutdown faults and stops repeated writes", async () => {
    const { client, logger, output } = setup()
    client.info.mockImplementation(() => {
      throw new Error("https://private.test/?token=private-export")
    })
    client.shutdown.mockRejectedValue(new Error("private-shutdown"))
    for (let count = 0; count < 30; count++) logger.info("Operation complete")
    expect(client.info).toHaveBeenCalledOnce()
    await expect(logger.shutdown?.()).resolves.toBeUndefined()
    expect(output()).toContain("telemetry.write.failed")
    expect(output()).toContain("telemetry.shutdown.failed")
    expect(output()).not.toContain("private-")
  })

  it("contains configuration faults and closed stderr, and honors verbosity", async () => {
    const { client, logger, stderr } = setup(false, "")
    logger.debug("hidden")
    expect(stderr).not.toHaveBeenCalled()
    logger.info("local")
    expect(client.configure).not.toHaveBeenCalled()
    expect(client.info).not.toHaveBeenCalled()
    stderr.mockImplementation(() => {
      throw new Error("closed")
    })
    expect(() => logger.error("business continues")).not.toThrow()
    client.configure.mockImplementation(() => {
      throw new Error("private-config")
    })
    const fallback = createLogger(false, "write-token", client)
    loggers.push(fallback)
    await expect(fallback.span?.("app.work", {}, async () => 123)).resolves.toBe(123)
    await fallback.shutdown?.()
    expect(client.shutdown).not.toHaveBeenCalled()
  })
})
