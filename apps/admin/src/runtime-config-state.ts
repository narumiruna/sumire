import type { RuntimeConfigEntry, RuntimeConfigResponse } from "@narumitw/sumire-contracts"

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
    throw new Error("Could not verify runtime configuration.")
  const entries: RuntimeConfigEntry[] = value.entries.map((entry) => {
    if (
      !entry ||
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(entry.name) ||
      !Number.isSafeInteger(entry.revision) ||
      entry.revision < 1 ||
      !Number.isFinite(entry.updatedAt) ||
      entry.updatedAt < 0
    )
      throw new Error("Invalid entry metadata.")
    const metadata = { name: entry.name, revision: entry.revision, updatedAt: entry.updatedAt }
    if (entry.kind === "secret" && entry.configured === true)
      return { ...metadata, kind: "secret", configured: true }
    if (entry.kind === "variable" && typeof entry.value === "string")
      return { ...metadata, kind: "variable", value: entry.value }
    throw new Error("Invalid entry metadata.")
  })
  return {
    revision: value.revision,
    applied: value.applied,
    status: value.status,
    secretStatus: value.secretStatus,
    entries,
  }
}

export function runtimeValueError(name: string, kind: "secret" | "variable", value: string) {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name))
    return "Use an uppercase name starting with A–Z, with only A–Z, digits, and underscores (maximum 128 characters)."
  if (
    ["BOT_TOKEN", "BOT_ADMIN_ID", "LOGFIRE_TOKEN", "ENCRYPTION_KEY"].includes(name) ||
    name.startsWith("ADMIN_")
  )
    return "This name is reserved for host configuration."
  if (kind === "secret" && !value) return "Enter a nonempty replacement secret."
  if (new TextEncoder().encode(value).length > 8192)
    return "The value must not exceed 8 KiB of UTF-8."
  return ""
}
