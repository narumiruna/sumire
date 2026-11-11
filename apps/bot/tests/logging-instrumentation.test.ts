import { createServer, get } from "node:http"

import { SpanStatusCode } from "@opentelemetry/api"
import { BatchSpanProcessor, type ReadableSpan, type SpanProcessor } from "@opentelemetry/sdk-trace"
import * as logfire from "@pydantic/logfire-node"
import { GrammyError, HttpError } from "grammy"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createLogger, type LogfireClient } from "../src/logging.js"

type Record = {
  name: string
  attributes: object
  status: object
  events: unknown
  traceId: string
  parentSpanId?: string
}

function capture(records: Record[]): SpanProcessor {
  return {
    onStart() {},
    onEnd(span: ReadableSpan) {
      records.push({
        name: span.name,
        attributes: { ...span.attributes },
        status: { ...span.status },
        events: span.events,
        traceId: span.spanContext().traceId,
        parentSpanId: span.parentSpanContext?.spanId,
      })
    },
    async shutdown() {},
    async forceFlush() {},
  }
}

function offlineClient(records: Record[], processors: SpanProcessor[] = []): LogfireClient {
  return {
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
        advanced: { pendingSpans: false },
        additionalSpanProcessors: [capture(records), ...processors],
      })
    },
  }
}

const loggers: ReturnType<typeof createLogger>[] = []
afterEach(async () => {
  for (const logger of loggers.splice(0)) await logger.shutdown?.()
  await logfire.shutdown()
  vi.restoreAllMocks()
})

describe("real offline Logfire 0.23 regressions", () => {
  it("reproduces default session_id scrubbing and preserves reviewed correlation, policy words and braces", async () => {
    const records: Record[] = []
    logfire.configure({
      sendToLogfire: false,
      metrics: false,
      variables: false,
      apiKey: "",
      console: false,
      minLevel: null,
      sampling: { head: 1 },
      scrubbing: {},
      advanced: { pendingSpans: false },
      additionalSpanProcessors: [capture(records)],
    })
    const sessionId = "019b3124-7d5e-7e13-8ad2-f16808049bb3"
    const toolCallId = "call_AbZ9_mN-2|fc_A1b2Z9"
    logfire.info("{message}", {
      message: "Created session_id=normal-session",
      "pi.session_id": sessionId,
    })
    expect(records[0]?.attributes).not.toMatchObject({ "pi.session_id": sessionId })
    expect(JSON.stringify(records[0])).not.toContain("normal-session")
    await logfire.shutdown()
    records.length = 0
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {})
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const logger = createLogger(true, "offline-write-token", offlineClient(records))
    loggers.push(logger)
    const message =
      'Created session_id=normal-session; API key and Cookie policy {source} {{literal}} {} {"phase":"download"}'
    await logger.span?.(
      "telegram.request",
      { "telegram.chat_id": 42, "pi.session_id": sessionId, "pi.tool_call_id": toolCallId },
      async (span) => {
        span.setAttribute("pi.parent_tool_call_id", toolCallId)
        for (const level of ["debug", "info", "warn", "error"] as const) {
          logger[level](message, {
            "event.name": "pi.tool.start",
            "telegram.chat_id": 42,
            "pi.session_id": sessionId,
            "pi.tool_call_id": toolCallId,
            "pi.parent_tool_call_id": toolCallId,
            "pi.instructions_chars": 123,
            "pi.instructions_sha256": "f".repeat(64),
            "pi.tools": ["read_url", "Cookie_policy"],
            "pi.codemode_tools": ["API_key_policy"],
          })
        }
      },
    )
    expect(records.find((record) => record.name === "telegram.request")?.attributes).toMatchObject({
      "pi.tool_call_id": toolCallId,
      "pi.parent_tool_call_id": toolCallId,
    })
    const logs = records.filter((record) => record.name === "{sumire_message}")
    expect(logs).toHaveLength(4)
    expect(warning).not.toHaveBeenCalled()
    for (const record of logs) {
      expect(record.attributes).toMatchObject({
        "event.name": "pi.tool.start",
        "telegram.chat_id": 42,
        "pi.session_id": sessionId,
        "pi.tool_call_id": toolCallId,
        "pi.parent_tool_call_id": toolCallId,
        "pi.instructions_chars": 123,
        "pi.instructions_sha256": "f".repeat(64),
        "logfire.msg": message,
        sumire_message: message,
      })
      expect(JSON.stringify(record.attributes)).toContain("Cookie_policy")
      expect(JSON.stringify(record.attributes)).toContain("API_key_policy")
      expect(record.traceId).toBe(
        records.find((record) => record.name === "telegram.request")?.traceId,
      )
      expect(record.parentSpanId).toBeDefined()
    }
    expect(logs.map((record) => Reflect.get(record.attributes, "logfire.level_num"))).toEqual([
      5, 9, 13, 17,
    ])
    expect(logfire.logfireApiConfig.scrubber).toBeInstanceOf(logfire.LogfireAttributeScrubber)
    // Safe keys are narrow: non-application fields still use the default scrubber.
    logfire.info("unreviewed field", { authorization: "private-authorization" })
    logfire.info("{message}", {
      message: "Created session_id=unreviewed-session API key and Cookie policy",
    })
    expect(JSON.stringify(records)).not.toContain("private-authorization")
    expect(JSON.stringify(records)).not.toContain("unreviewed-session")
    expect(stderr.mock.calls.flat().join(" ")).toContain(message)
  })

  it("preserves the existing browser smoke-verification contract", async () => {
    const records: Record[] = []
    const logger = createLogger(false, "offline-write-token", offlineClient(records))
    loggers.push(logger)
    await logger.span?.(
      "browser.verify",
      {
        "verification.kind": "browser-runtime-smoke",
        "verification.target": "https://private.test/?signature=private-target",
      },
      async (span) => {
        span.setAttribute("verification.outcome", "success")
      },
    )
    expect(records.find(({ name }) => name === "browser.verify")?.attributes).toMatchObject({
      "verification.kind": "browser-runtime-smoke",
      "verification.outcome": "success",
    })
    expect(JSON.stringify(records)).not.toContain("private-")
  })

  it("exports real ERROR status/level and safe error facts, never GrammyError response content or credential URLs", async () => {
    const records: Record[] = []
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const logger = createLogger(false, "offline-write-token", offlineClient(records))
    loggers.push(logger)
    const failure = new GrammyError(
      "https://api.telegram.org/bot123456:private-token/sendMessage?signature=private-query",
      { ok: false, error_code: 400, description: "private-description" },
      "sendMessage",
      { text: "private-response-body", document: "private-file-id", caption: "private-caption" },
    )
    failure.cause = Object.assign(new Error("https://private.test/?api_key=private-cause"), {
      code: "ECONNRESET",
    })
    logger.error("Telegram delivery failed", {
      "event.name": "telegram.delivery.failed",
      error: failure,
    })
    await expect(
      logger.span?.(
        "telegram.deliver",
        {
          "pi.session_id": "normal-session",
          "telegram.chat_id": 42,
          "request.payload": "private-span-body",
          "delivery.method": "https://private.test/?secret=private-method",
        },
        async (span) => {
          span.setAttribute("pi.tool_name", "https://private.test/?cookie=private-tool")
          span.setAttribute("request.body", "private-mutated-body")
          span.setStatus?.({ code: SpanStatusCode.ERROR, message: "private-status-description" })
          throw failure
        },
      ),
    ).rejects.toBe(failure)
    const failed = records.find((record) => record.name === "telegram.deliver")
    expect(failed?.status).toEqual({ code: SpanStatusCode.ERROR })
    expect(failed?.attributes).toMatchObject({
      "operation.outcome": "error",
      "logfire.level_num": 17,
      "error.type": "GrammyError",
      "http.response.status_code": 400,
      "http.request.method": "sendMessage",
      "error.cause.1.code": "ECONNRESET",
      "pi.session_id": "normal-session",
      "telegram.chat_id": 42,
    })
    expect(failed?.events).toEqual([])
    const cancelled = new HttpError(
      "private-cancel-wrapper",
      new Error("private-cancel-cause", {
        cause: new DOMException("private-cancel-body", "AbortError"),
      }),
    )
    await expect(
      logger.span?.("pi.cancel", {}, async () => {
        throw cancelled
      }),
    ).rejects.toBe(cancelled)
    const cancelledRecord = records.find((record) => record.name === "pi.cancel")
    expect(cancelledRecord?.status).toEqual({ code: SpanStatusCode.UNSET })
    expect(cancelledRecord?.attributes).toMatchObject({ "operation.outcome": "cancelled" })
    expect(Reflect.get(cancelledRecord?.attributes ?? {}, "logfire.level_num")).not.toBe(17)
    const output = JSON.stringify(records) + JSON.stringify(stderr.mock.calls)
    for (const secret of ["private-", "private.test", "api.telegram.org", "offline-write-token"])
      expect(output).not.toContain(secret)
  })

  it.each(["cancelled", "rejected", "rejected_input", "success", "incomplete"])(
    "preserves only explicit non-error rejection classifications (%s)",
    async (outcome) => {
      const records: Record[] = []
      vi.spyOn(process.stderr, "write").mockImplementation(() => true)
      const logger = createLogger(false, "offline-write-token", offlineClient(records))
      loggers.push(logger)
      const failure = new Error("https://private.test/?secret=private-classified-error")
      await expect(
        logger.span?.("telegram.download", {}, async (span) => {
          span.setAttribute("operation.outcome", outcome)
          throw failure
        }),
      ).rejects.toBe(failure)
      const record = records.find((record) => record.name === "telegram.download")
      const nonError = ["cancelled", "rejected", "rejected_input"].includes(outcome)
      expect(record?.status).toEqual({
        code: nonError ? SpanStatusCode.UNSET : SpanStatusCode.ERROR,
      })
      expect(record?.attributes).toMatchObject({
        "operation.outcome": nonError ? outcome : "error",
        "error.type": "Error",
      })
      expect(Reflect.get(record?.attributes ?? {}, "logfire.level_num") === 17).toBe(!nonError)
      expect(record?.events).toEqual([])
      expect(JSON.stringify(records)).not.toContain("private-")
    },
  )

  it("reports real asynchronous exporter errors and queue warnings only to bounded stderr diagnostics", async () => {
    const records: Record[] = []
    let exports = 0
    const exporter = new BatchSpanProcessor({
      exporter: {
        export(_spans, callback) {
          exports++
          setTimeout(
            () =>
              callback({
                code: 1,
                error: new Error("https://private.test/?token=private-export-body"),
              }),
            5,
          )
        },
        async shutdown() {},
      },
      maxQueueSize: 2,
      maxExportBatchSize: 1,
      scheduledDelayMillis: 10,
      exportTimeoutMillis: 1_000,
    })
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const logger = createLogger(false, "offline-write-token", offlineClient(records, [exporter]))
    loggers.push(logger)
    for (let count = 0; count < 20; count++)
      logger.info("Work complete", { "event.name": "app.work.complete" })
    await vi.waitFor(() =>
      expect(stderr.mock.calls.flat().join(" ")).toContain("telemetry.sdk.error"),
    )
    await new Promise((resolve) => setTimeout(resolve, 30))
    logger.info("Work complete", { "event.name": "app.work.complete" })
    expect(stderr.mock.calls.flat().join(" ")).toContain("telemetry.sdk.warning")
    for (let count = 0; count < 20; count++) {
      // Public diag, no text classification and no forwarding raw arguments.
      const { diag } = await import("@opentelemetry/api")
      diag.error("private-diagnostic-message", { payload: "private-diagnostic-payload" })
    }
    await logger.shutdown?.()
    expect(exports).toBeGreaterThan(0)
    const diagnosticLines = stderr.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes("| WARN | telemetry."))
    expect(diagnosticLines.length).toBeLessThanOrEqual(11)
    expect(diagnosticLines.join("")).toContain("telemetry.diagnostics.suppressed")
    expect(diagnosticLines.join("")).not.toContain("private-")
    expect(records).toHaveLength(21)
    expect(JSON.stringify(records)).not.toContain("telemetry.sdk")
    expect(JSON.stringify(records)).not.toContain("private-")
  })

  it("keeps manual spans without automatic HTTP credential records", async () => {
    const records: Record[] = []
    const server = createServer((_request, response) => {
      response.writeHead(200)
      response.end("ok")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing test server port")
    try {
      const logger = createLogger(false, "offline-write-token", offlineClient(records))
      loggers.push(logger)
      const endpoint = `http://127.0.0.1:${address.port}`
      await logger.span?.("telegram.request", { "telegram.message_id": 42 }, async () => {
        expect(
          (
            await fetch(`${endpoint}/bot123456:private-token/getMe`, {
              headers: { Authorization: "Bearer private-header" },
            })
          ).ok,
        ).toBe(true)
        await new Promise<void>((resolve, reject) => {
          get(`${endpoint}/?api_key=private-query`, (response) => {
            response.resume()
            response.on("end", resolve)
            response.on("error", reject)
          }).on("error", reject)
        })
      })
      expect(records.some((record) => record.name === "telegram.request")).toBe(true)
      expect(JSON.stringify(records)).not.toContain("private-")
      expect(records.some((record) => "url.full" in record.attributes)).toBe(false)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })
})
