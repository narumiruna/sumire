import type { RuntimeConfigEntry, RuntimeConfigResponse } from "@narumitw/sumire-contracts"

import { LocalizedError, type MessageKey, t } from "./i18n.js"

/** Validate a safe save base. Never retain additional response fields. */
export function parseRuntimeConfig(value: RuntimeConfigResponse): RuntimeConfigResponse {
  if (
    !value ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !Number.isSafeInteger(value.applied) ||
    value.applied < 0 ||
    !["ready", "unavailable", "locked"].includes(value.secretStatus) ||
    typeof value.status !== "string" ||
    !value.status ||
    !Array.isArray(value.entries)
  )
    throw new LocalizedError("runtime.verifyFailed")
  const entries: RuntimeConfigEntry[] = value.entries.map((entry) => {
    if (
      !entry ||
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(entry.name) ||
      !Number.isSafeInteger(entry.revision) ||
      entry.revision < 1 ||
      !Number.isFinite(entry.updatedAt) ||
      entry.updatedAt < 0
    )
      throw new LocalizedError("runtime.invalidEntry")
    const metadata = { name: entry.name, revision: entry.revision, updatedAt: entry.updatedAt }
    if (entry.kind === "secret" && entry.configured === true)
      return { ...metadata, kind: "secret", configured: true }
    if (entry.kind === "variable" && typeof entry.value === "string")
      return { ...metadata, kind: "variable", value: entry.value }
    throw new LocalizedError("runtime.invalidEntry")
  })
  return {
    revision: value.revision,
    applied: value.applied,
    status: value.status,
    secretStatus: value.secretStatus,
    entries,
  }
}

export function runtimeValueErrorKey(
  name: string,
  kind: "secret" | "variable",
  value: string,
): MessageKey | "" {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) return "runtime.nameInvalid"
  if (
    ["BOT_TOKEN", "BOT_ADMIN_ID", "LOGFIRE_TOKEN", "ENCRYPTION_KEY"].includes(name) ||
    name.startsWith("ADMIN_")
  )
    return "runtime.nameReserved"
  if (kind === "secret" && !value) return "runtime.secretRequired"
  if (new TextEncoder().encode(value).length > 8192) return "runtime.valueLimit"
  return ""
}

export function runtimeValueError(name: string, kind: "secret" | "variable", value: string) {
  const key = runtimeValueErrorKey(name, kind, value)
  if (key) return t(key)
  return ""
}
