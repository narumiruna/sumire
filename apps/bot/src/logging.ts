import { inspect } from "node:util"

import * as logfire from "@pydantic/logfire-node"

const telegramBotTokenPattern = /\/bot\d+:[A-Za-z0-9_-]+/g
const firecrawlMcpPattern = /https:\/\/mcp\.firecrawl\.dev\/[^/\s]+\/v2\/mcp/gi
const sensitiveQuotedValuePattern =
  /\b(token|api[_-]?key|authorization|cookie|set-cookie|password|secret)(\s*[:=]\s*)(['"])(.*?)\3/gi
const sensitiveBareValuePattern =
  /\b(token|api[_-]?key|authorization|cookie|set-cookie|password|secret)(\s*[:=]\s*)((?!['"])[^\s;,}]+)/gi
const bearerPattern = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi

export function redactLogMessage(message: string): string {
  return message
    .replace(firecrawlMcpPattern, "https://mcp.firecrawl.dev/[redacted]/v2/mcp")
    .replace(telegramBotTokenPattern, "/bot[redacted]")
    .replace(bearerPattern, "Bearer [redacted]")
    .replace(sensitiveQuotedValuePattern, "$1$2$3[redacted]$3")
    .replace(sensitiveBareValuePattern, "$1$2[redacted]")
}

export type SpanAttributes = Record<string, string | number | boolean>

export interface TraceSpan {
  setAttribute(key: string, value: string | number | boolean): void
}

const noOpSpan: TraceSpan = { setAttribute: () => {} }

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
  configure(options: { token: string; serviceName: string; console: false }): void
  debug(message: string): void
  info(message: string): void
  warning(message: string): void
  error(message: string): void
  shutdown(options?: { timeoutMillis?: number }): Promise<void>
  span?: <T>(
    name: string,
    options: { attributes: SpanAttributes; callback: (span: TraceSpan) => Promise<T> },
  ) => Promise<T>
}

export function withLogSpan<T>(
  logger: Logger,
  name: string,
  attributes: SpanAttributes,
  callback: (span: TraceSpan) => Promise<T>,
): Promise<T> {
  return logger.span ? logger.span(name, attributes, callback) : callback(noOpSpan)
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
  const writeLocal = (level: string, message: string, details?: unknown) => {
    const suffix =
      details === undefined ? "" : ` ${inspect(details, { depth: 5, breakLength: 120 })}`
    process.stderr.write(`${new Date().toISOString()} | ${level} | ${redact(message + suffix)}\n`)
  }

  let logfireEnabled = false
  if (logfireToken) {
    try {
      logfireClient.configure({
        token: logfireToken,
        serviceName: "sumire",
        console: false,
      })
      logfireEnabled = true
    } catch (error) {
      writeLocal("WARN", "Logfire configuration failed; using stderr only", error)
    }
  }

  const write = (
    level: "DEBUG" | "INFO" | "WARN" | "ERROR",
    message: string,
    details?: unknown,
  ) => {
    const suffix =
      details === undefined ? "" : ` ${inspect(details, { depth: 5, breakLength: 120 })}`
    const redacted = redact(message + suffix)
    process.stderr.write(`${new Date().toISOString()} | ${level} | ${redacted}\n`)
    if (!logfireEnabled) return
    try {
      if (level === "DEBUG") logfireClient.debug(redacted)
      else if (level === "INFO") logfireClient.info(redacted)
      else if (level === "WARN") logfireClient.warning(redacted)
      else logfireClient.error(redacted)
    } catch (error) {
      writeLocal("WARN", "Logfire write failed", error)
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
      try {
        await logfireClient.span(name, {
          attributes,
          callback: (span) => {
            operation ??= Promise.resolve().then(() =>
              callback({
                setAttribute: (key, value) => {
                  try {
                    span.setAttribute(key, value)
                  } catch (error) {
                    writeLocal("WARN", "Logfire span attribute failed", error)
                  }
                },
              }),
            )
            return operation
          },
        })
      } catch (error) {
        if (operation) {
          const result = await operation
          writeLocal("WARN", "Logfire span failed; continuing without trace", error)
          return result
        }
        writeLocal("WARN", "Logfire span failed; continuing without trace", error)
      }
      operation ??= Promise.resolve().then(() => callback(noOpSpan))
      return operation
    },
    debug: (message, details) => {
      if (verbose) write("DEBUG", message, details)
    },
    info: (message, details) => write("INFO", message, details),
    warn: (message, details) => write("WARN", message, details),
    error: (message, details) => write("ERROR", message, details),
    async shutdown() {
      if (!logfireEnabled) return
      try {
        await logfireClient.shutdown({ timeoutMillis: 5_000 })
      } catch (error) {
        writeLocal("WARN", "Logfire shutdown failed", error)
      }
    },
  }
}
