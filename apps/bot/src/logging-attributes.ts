import { sanitizeUrlAttempts } from "@narumitw/sumire-pi-url-reader"

import type { SpanAttributes } from "./logging.js"

const urlPattern = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"<>]+/giu
const authorizationPattern = /\b(Bearer|Basic)\s+[^\s;,}]+/gi
const credentialHeaderPattern = /\b(authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi
const quotedSecretPattern =
  /\b(token|api[ _-]?key|authorization|cookie|set-cookie|password|secret)(\s*[:=]\s*)(['"])(.*?)\3/gi
const bareSecretPattern =
  /\b(token|api[ _-]?key|authorization|cookie|set-cookie|password|secret)(\s*[:=]\s*)((?!['"])[^\s;,}]+)/gi
const telegramTokenPattern = /\b(?:bot)?\d{5,}:[A-Za-z0-9_-]+/g
const identifierPattern = /^[A-Za-z0-9_.:@/-]{1,256}$/u

export function redactLogMessage(message: string): string {
  return message
    .replace(urlPattern, "[redacted-url]")
    .replace(telegramTokenPattern, "[redacted]")
    .replace(authorizationPattern, "$1 [redacted]")
    .replace(credentialHeaderPattern, "$1=[redacted]")
    .replace(quotedSecretPattern, "$1$2$3[redacted]$3")
    .replace(bareSecretPattern, "$1$2[redacted]")
}

// Exact, reviewed keys only. In particular, no text, file IDs, paths, URLs,
// request objects, payloads, error messages, or stacks cross this boundary.
const numericKeys = [
  "telegram.chat_id",
  "telegram.message_id",
  "telegram.update_id",
  "telegram.text_chars",
  "telegram.images",
  "telegram.documents",
  "telegram.audio",
  "pi.prompt_chars",
  "pi.image_count",
  "pi.reply_to_bot_message_id",
  "pi.attempt",
  "pi.input_tokens",
  "pi.output_tokens",
  "pi.cache_read_tokens",
  "pi.cache_write_tokens",
  "pi.total_tokens",
  "pi.duration_ms",
  "pi.instructions_chars",
  "pi.conversation_id",
  "pi.submission_id",
  "pi.task_id",
  "pi.parent_task_id",
  "pi.entry_id",
  "delivery.message_id",
  "delivery.content_chars",
  "delivery.bytes",
  "delivery.confirmed_components",
  "download.attempts",
  "download.bytes",
  "download.max_bytes",
  "recovery.chat_count",
  "url.content_chars",
  "url.http_status",
  "morsel.content_chars",
  "http.status_code",
  "http.response.status_code",
  "failures",
] as const
const identifierKeys = [
  "event.name",
  "telegram.chat_type",
  "telegram.outcome",
  "pi.session_id",
  "pi.entry_id",
  "pi.tool_call_id",
  "pi.tool_name",
  "pi.outcome",
  "pi.intent",
  "pi.phase",
  "pi.model",
  "pi.provider",
  "pi.stop_reason",
  "pi.instructions_sha256",
  "pi.parent_tool_call_id",
  "pi.trigger",
  "pi.reason",
  "pi.settled_status",
  "pi.submission_type",
  "pi.report_kind",
  "pi.task_kind",
  "pi.request_id",
  "telegram.failure_stage",
  "telegram.media_kind",
  "delivery.mode",
  "delivery.outcome",
  "delivery.component_id",
  "delivery.component_kind",
  "delivery.method",
  "delivery.stage",
  "download.phase",
  "download.outcome",
  "recovery.outcome",
  "recovery.phase",
  "operation.outcome",
  "url.outcome",
  "url.source",
  "url.loader",
  "url.requested_loader",
  "url.error_code",
  "url.fingerprint",
  "url.final_fingerprint",
  "url.host",
  "telegram.input_url_fingerprint",
  "morsel.outcome",
  "morsel.delivery_mode",
  "morsel.error_type",
  "http.request.method",
  "application.resource",
  "application.signal",
  "verification.kind",
  "verification.outcome",
] as const
const booleanKeys = [
  "telegram.has_reply",
  "pi.success",
  "pi.blocking",
  "pi.reply_branch_restored",
  "pi.imagegen_available",
  "pi.imagegen_permitted",
  "pi.imagegen_installed",
  "url.truncated",
] as const
const numericKeySet = new Set<string>(numericKeys)
const identifierKeySet = new Set<string>(identifierKeys)
const booleanKeySet = new Set<string>(booleanKeys)

// Default SDK scrubbing stays enabled. These exact keys contain only projected
// facts. This also keeps session_id and policy words in normal messages intact.
const arrayKeys = ["pi.tools", "pi.codemode_tools"] as const
export const safeLogfireKeys = [
  "sumire_message",
  ...numericKeys,
  ...identifierKeys,
  ...booleanKeys,
  ...arrayKeys,
]
export type LogAttributes = Record<string, string | number | boolean | string[]>

export function field(value: unknown, key: string): unknown {
  try {
    return value !== null && (typeof value === "object" || typeof value === "function")
      ? Reflect.get(value, key)
      : undefined
  } catch {
    return undefined
  }
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && identifierPattern.test(value)
}

function toolCallIdentifier(key: string, value: unknown): value is string {
  return (
    (key === "pi.tool_call_id" || key === "pi.parent_tool_call_id") &&
    typeof value === "string" &&
    value.length <= 256 &&
    /^call_[A-Za-z0-9_-]{1,128}\|fc_[A-Za-z0-9_-]{1,128}$/u.test(value)
  )
}

function errorIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_.]{0,79}$/u.test(value)
}

function nestedError(error: unknown): unknown {
  return (
    field(error, "cause") ??
    (field(error, "name") === "HttpError" ? field(error, "error") : undefined)
  )
}

export function isCancellation(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current = error
  for (let depth = 0; current !== undefined && current !== null && depth < 4; depth++) {
    if (seen.has(current)) break
    seen.add(current)
    const name = field(current, "name")
    const code = field(current, "code")
    if (name === "AbortError" || code === "ABORT_ERR" || code === "ERR_CANCELED") return true
    current = nestedError(current)
  }
  return false
}

/** Never read message, stack, request, response body, payload, or custom inspect. */
export function errorAttributes(error: unknown): SpanAttributes {
  const attributes: SpanAttributes = {}
  const seen = new Set<unknown>()
  let current = error
  for (let depth = 0; current !== undefined && current !== null && depth < 4; depth++) {
    if (seen.has(current)) break
    seen.add(current)
    const prefix = depth === 0 ? "error" : `error.cause.${depth}`
    const name = field(current, "name")
    attributes[`${prefix}.type`] = errorIdentifier(name) ? name : "unknown"
    const code = field(current, "code")
    if (errorIdentifier(code) || (typeof code === "number" && Number.isFinite(code))) {
      attributes[`${prefix}.code`] = code
    }
    const status =
      field(current, "status") ?? field(current, "statusCode") ?? field(current, "error_code")
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
      attributes[depth === 0 ? "http.response.status_code" : `${prefix}.http_status`] = status
    }
    const method = field(current, "method")
    if (typeof method === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(method)) {
      attributes[depth === 0 ? "http.request.method" : `${prefix}.method`] = method
    }
    current = nestedError(current)
  }
  return attributes
}

function isErrorKey(key: string): boolean {
  return /^error(?:\.cause\.[1-3])?\.(?:type|code|http_status|method)$/u.test(key)
}

export function projectAttributes(
  details: unknown,
  redact: (value: string) => string = redactLogMessage,
): SpanAttributes {
  const attributes: SpanAttributes = {}
  // Iterate the schema, not arbitrary upstream object keys or toJSON methods.
  for (const key of numericKeys) {
    const value = field(details, key)
    if (typeof value === "number" && Number.isFinite(value)) attributes[key] = value
  }
  for (const key of identifierKeys) {
    const value = field(details, key)
    if (identifier(value) || toolCallIdentifier(key, value)) attributes[key] = redact(value)
  }
  for (const key of booleanKeys) {
    const value = field(details, key)
    if (typeof value === "boolean") attributes[key] = value
  }
  for (let depth = 0; depth < 4; depth++) {
    const prefix = depth === 0 ? "error" : `error.cause.${depth}`
    for (const suffix of ["type", "code", "http_status", "method"]) {
      const key = `${prefix}.${suffix}`
      const value = field(details, key)
      if (errorIdentifier(value)) attributes[key] = redact(value)
      else if (
        (suffix === "code" || suffix === "http_status") &&
        typeof value === "number" &&
        Number.isFinite(value)
      )
        attributes[key] = value
    }
  }
  const error = field(details, "error")
  const directError = field(details, "name") !== undefined
  if (error !== undefined || directError) {
    for (const [key, value] of Object.entries(errorAttributes(error ?? details))) {
      attributes[key] = typeof value === "string" ? redact(value) : value
    }
  }
  // URL loaders already define a bounded, typed projection. Reapply it after
  // decoding; accepting arbitrary JSON strings here would bypass the boundary.
  const attempts = field(details, "url.attempts")
  if (typeof attempts === "string" && attempts.length <= 32_768) {
    try {
      attributes["url.attempts"] = JSON.stringify(sanitizeUrlAttempts(JSON.parse(attempts)))
    } catch {
      // Malformed diagnostics are not telemetry.
    }
  }
  const diagnostic = field(details, "url.diagnostic")
  if (typeof diagnostic === "string" && diagnostic.length <= 4_096) {
    try {
      const safe = sanitizeUrlAttempts([
        { loaderId: "unknown", status: "failed", diagnostic: JSON.parse(diagnostic) },
      ])[0]?.diagnostic
      if (safe) attributes["url.diagnostic"] = JSON.stringify(safe)
    } catch {
      // Malformed diagnostics are not telemetry.
    }
  }
  return attributes
}

export function projectLogAttributes(
  details: unknown,
  redact: (value: string) => string,
): LogAttributes {
  const attributes: LogAttributes = projectAttributes(details, redact)
  for (const key of arrayKeys) {
    const value = field(details, key)
    const length = field(value, "length")
    if (typeof length !== "number" || !Number.isInteger(length) || length < 0) continue
    const items: string[] = []
    for (let index = 0; index < Math.min(length, 32); index++) {
      const item = field(value, String(index))
      if (identifier(item)) items.push(redact(item))
    }
    attributes[key] = items
  }
  return attributes
}

export function projectAttribute(
  key: string,
  value: string | number | boolean,
  redact: (value: string) => string,
): SpanAttributes {
  if (
    !numericKeySet.has(key) &&
    !identifierKeySet.has(key) &&
    !booleanKeySet.has(key) &&
    !isErrorKey(key) &&
    key !== "url.attempts" &&
    key !== "url.diagnostic" &&
    key !== "logfire.level_num"
  )
    return {}
  if (key === "logfire.level_num") return value === 17 ? { [key]: value } : {}
  return projectAttributes({ [key]: value }, redact)
}
