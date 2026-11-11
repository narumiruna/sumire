import { SpanStatusCode } from "@opentelemetry/api"
import * as logfire from "@pydantic/logfire-node"

import {
  errorAttributes,
  isCancellation,
  type LogAttributes,
  projectAttribute,
  projectAttributes,
  projectLogAttributes,
  redactLogMessage,
  safeLogfireKeys,
} from "./logging-attributes.js"
import { createLocalDiagnostics, ownSdkRuntime } from "./logging-runtime.js"

export { errorAttributes, isCancellation, redactLogMessage }

// HTTP instrumentation records full URLs before application redaction. Keep
// manual spans; Telegram embeds credentials in API paths as well as queries.
export const safeNodeAutoInstrumentations = {
  "@opentelemetry/instrumentation-fs": { enabled: false },
  "@opentelemetry/instrumentation-http": { enabled: false },
  "@opentelemetry/instrumentation-undici": { enabled: false },
} as const

export type SpanAttributes = Record<string, string | number | boolean>

export interface TraceSpan {
  setAttribute(key: string, value: string | number | boolean): void
  setStatus?(status: { code: SpanStatusCode; message?: string }): void
}

const noOpSpan: TraceSpan = { setAttribute() {}, setStatus() {} }

export interface Logger {
  span?<T>(
    name: string,
    attributes: SpanAttributes,
    callback: (span: TraceSpan) => Promise<T>,
  ): Promise<T>
  debug(message: string, details?: unknown): void
  info(message: string, details?: unknown): void
  warn(message: string, details?: unknown): void
  error(message: string, details?: unknown): void
  shutdown?(): Promise<void>
}

export interface LogfireClient {
  configure(options: {
    token: string
    serviceName: string
    console: false
    nodeAutoInstrumentations: typeof safeNodeAutoInstrumentations
    scrubbing: { safeKeys: string[] }
  }): void
  debug(message: string, attributes?: Record<string, unknown>): void
  info(message: string, attributes?: Record<string, unknown>): void
  warning(message: string, attributes?: Record<string, unknown>): void
  error(message: string, attributes?: Record<string, unknown>): void
  forceFlush?(options?: { timeoutMillis?: number }): Promise<void>
  shutdown(options?: { timeoutMillis?: number }): Promise<void>
  span?: <T>(
    name: string,
    options: { attributes: SpanAttributes; callback: (span: TraceSpan) => Promise<T> },
  ) => Promise<T>
}

export function withLogSpan<T>(
  logger: Logger | undefined,
  name: string,
  attributes: SpanAttributes,
  callback: (span: TraceSpan) => Promise<T>,
): Promise<T> {
  return logger?.span ? logger.span(name, attributes, callback) : callback(noOpSpan)
}

/** Set a real error outcome without recording an unsafe exception event. */
export function setSpanError(span: TraceSpan, error?: unknown): void {
  const cancelled = isCancellation(error)
  const attributes = cancelled
    ? { "operation.outcome": "cancelled" }
    : {
        "operation.outcome": "error",
        ...errorAttributes(error),
        "logfire.level_num": logfire.Level.Error,
      }
  for (const [key, value] of Object.entries(attributes)) {
    try {
      span.setAttribute(key, value)
    } catch {
      // Optional telemetry must not replace the operation's original error.
    }
  }
  if (!cancelled) {
    try {
      span.setStatus?.({ code: SpanStatusCode.ERROR })
    } catch {
      // Older test spans need only setAttribute; SDK failures are not business failures.
    }
  }
}

function eventName(value: unknown, fallback: string): string {
  return typeof value === "string" &&
    /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u.test(value) &&
    value.length <= 120
    ? value
    : fallback
}

export function createLogger(
  verbose = false,
  logfireToken?: string,
  logfireClient: LogfireClient = logfire,
): Logger {
  const redact = (message: string) => {
    const redacted = redactLogMessage(message)
    return logfireToken ? redacted.replaceAll(logfireToken, "[redacted]") : redacted
  }
  const writeLocal = (level: string, message: string, attributes: LogAttributes) => {
    try {
      process.stderr.write(
        `${new Date().toISOString()} | ${level} | ${message} ${JSON.stringify(attributes)}\n`,
      )
    } catch {
      // Logging to a closed pipe must not repeat or fail business work.
    }
  }
  const diagnose = createLocalDiagnostics((event, attributes) =>
    writeLocal("WARN", event, attributes),
  )
  let logfireEnabled = false
  let configured = false
  let releaseRuntime: (() => void) | undefined
  let shutdownPromise: Promise<void> | undefined

  const write = (
    level: "DEBUG" | "INFO" | "WARN" | "ERROR",
    message: string,
    details?: unknown,
  ) => {
    const attributes = projectLogAttributes(details, redact)
    attributes["event.name"] = eventName(attributes["event.name"], `app.log.${level.toLowerCase()}`)
    // Messages are application summaries, never containers for startup bodies
    // or inspected errors. New callers supply structured facts separately.
    attributes.sumire_message = redact(message.split(/[\r\n]/u, 1)[0] ?? "").slice(0, 1_024)
    writeLocal(level, attributes.sumire_message, attributes)
    if (!logfireEnabled) return
    try {
      // A constant template tolerates literal braces in application messages.
      if (level === "DEBUG") logfireClient.debug("{sumire_message}", attributes)
      else if (level === "INFO") logfireClient.info("{sumire_message}", attributes)
      else if (level === "WARN") logfireClient.warning("{sumire_message}", attributes)
      else logfireClient.error("{sumire_message}", attributes)
    } catch (error) {
      logfireEnabled = false
      diagnose("telemetry.write.failed", error)
    }
  }

  if (logfireToken) {
    try {
      releaseRuntime = ownSdkRuntime({
        configure: () =>
          logfireClient.configure({
            token: logfireToken,
            serviceName: "sumire",
            console: false,
            nodeAutoInstrumentations: safeNodeAutoInstrumentations,
            scrubbing: { safeKeys: safeLogfireKeys },
          }),
        diagnose,
        reportProcessError: (event, error) => write("ERROR", event, { "event.name": event, error }),
        flush: () => logfireClient.forceFlush?.({ timeoutMillis: 1_000 }) ?? Promise.resolve(),
        deactivate: () => {
          logfireEnabled = false
          configured = false
        },
      })
      configured = true
      logfireEnabled = true
    } catch (error) {
      diagnose("telemetry.configure.failed", error)
    }
  }

  return {
    span: async <T>(
      name: string,
      attributes: SpanAttributes,
      callback: (span: TraceSpan) => Promise<T>,
    ): Promise<T> => {
      if (!logfireEnabled || !logfireClient.span) return callback(noOpSpan)
      let operation: Promise<T> | undefined
      let explicitOutcome: string | undefined
      try {
        await logfireClient.span(eventName(name, "app.operation"), {
          attributes: projectAttributes(attributes, redact),
          callback: (span) => {
            const safeSpan: TraceSpan = {
              setAttribute: (key, value) => {
                try {
                  for (const [safeKey, safeValue] of Object.entries(
                    projectAttribute(key, value, redact),
                  )) {
                    if (safeKey === "operation.outcome" && typeof safeValue === "string") {
                      explicitOutcome = safeValue
                    }
                    span.setAttribute(safeKey, safeValue)
                  }
                } catch (error) {
                  diagnose("telemetry.span.attribute.failed", error)
                }
              },
              setStatus: (status) => {
                try {
                  // Status descriptions can contain upstream payloads too.
                  if (
                    [SpanStatusCode.UNSET, SpanStatusCode.OK, SpanStatusCode.ERROR].includes(
                      status.code,
                    )
                  ) {
                    span.setStatus?.({ code: status.code })
                  }
                } catch (error) {
                  diagnose("telemetry.span.status.failed", error)
                }
              },
            }
            operation ??= Promise.resolve().then(() => callback(safeSpan))
            // The SDK must not see a raw rejected callback: it records exception
            // messages/stacks and payload-bearing names before our boundary.
            return operation.then(
              (result) => result,
              (error) => {
                if (
                  explicitOutcome &&
                  ["cancelled", "rejected", "rejected_input"].includes(explicitOutcome)
                ) {
                  for (const [key, value] of Object.entries(errorAttributes(error)))
                    safeSpan.setAttribute(key, value)
                } else {
                  setSpanError(safeSpan, error)
                }
                return undefined as T
              },
            )
          },
        })
      } catch (error) {
        logfireEnabled = false
        diagnose("telemetry.span.failed", error)
      }
      // One shared promise covers SDK failure, early completion and late or
      // repeated SDK callbacks. Never repeat model work or ambiguous uploads.
      operation ??= Promise.resolve().then(() => callback(noOpSpan))
      return operation
    },
    debug: (message, details) => {
      if (verbose) write("DEBUG", message, details)
    },
    info: (message, details) => write("INFO", message, details),
    warn: (message, details) => write("WARN", message, details),
    error: (message, details) => write("ERROR", message, details),
    shutdown() {
      shutdownPromise ??= (async () => {
        if (!configured) return
        try {
          await logfireClient.shutdown({ timeoutMillis: 5_000 })
        } catch (error) {
          diagnose("telemetry.shutdown.failed", error)
        } finally {
          releaseRuntime?.()
        }
      })()
      return shutdownPromise
    },
  }
}
