import type {
  GitHubAccount,
  GitHubApplicationState,
  GitHubConnection,
  GitHubFlow,
  GitHubReceipt,
} from "@narumitw/sumire-contracts"

import { t } from "./i18n.js"

/** Known application states have labels; unknown stored metadata remains unchanged. */
export function githubApplicationStatusLabel(status: string) {
  switch (status) {
    case "applied":
      return t("settings.application.applied")
    case "pending":
      return t("settings.application.pending")
    case "failed":
      return t("settings.application.failed")
    case "unknown":
      return t("settings.application.unknown")
    default:
      return status
  }
}

export const githubVerificationUri = "https://github.com/login/device"

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(t("github.invalidMetadata"))
  return value as Record<string, unknown>
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
    throw new Error(t("github.invalidMetadata"))
  return value
}
function account(value: unknown): GitHubAccount {
  const data = object(value)
  if (
    typeof data.login !== "string" ||
    !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(data.login)
  )
    throw new Error(t("github.invalidAccount"))
  return { id: integer(data.id, 1), login: data.login }
}
function scopes(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 64 ||
    value.some((scope) => typeof scope !== "string" || !/^[a-z][a-z0-9:_-]{0,63}$/.test(scope))
  )
    throw new Error(t("github.invalidScopes"))
  return [...new Set(value as string[])]
}

/** Project known local application fields. Never retain upstream messages or extra fields. */
export function parseGitHubApplication(value: unknown): GitHubApplicationState {
  const data = object(value)
  if (
    data.status !== "applied" &&
    data.status !== "pending" &&
    data.status !== "failed" &&
    data.status !== "unknown"
  )
    throw new Error(t("github.invalidApplication"))
  const revision = integer(data.revision, 1)
  const applied = integer(data.applied)
  if (applied > revision) throw new Error(t("github.invalidApplication"))
  return { revision, applied, status: data.status }
}
function receipt(value: unknown): GitHubReceipt {
  const data = object(value)
  const savedRevision = integer(data.savedRevision, 1)
  const application = parseGitHubApplication(data.application)
  if (application.revision !== savedRevision) throw new Error(t("github.invalidReceipt"))
  return { savedRevision, application }
}
export function activeGitHubFlow(flow?: GitHubFlow): boolean {
  return flow?.status === "pending" || flow?.status === "authorized"
}

/** Codes and the fixed verification link are accepted only for a pending interaction. */
export function parseGitHubFlow(value: unknown): GitHubFlow {
  const data = object(value)
  if (typeof data.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(data.id))
    throw new Error(t("github.invalidInteraction"))
  if (
    data.status !== "pending" &&
    data.status !== "authorized" &&
    data.status !== "completed" &&
    data.status !== "cancelled" &&
    data.status !== "expired" &&
    data.status !== "failed" &&
    data.status !== "conflict"
  )
    throw new Error(t("github.invalidInteraction"))
  const result: GitHubFlow = {
    id: data.id,
    status: data.status,
    expiresAt: integer(data.expiresAt),
  }
  if (result.expiresAt > 8640000000000000) throw new Error(t("github.invalidDeadline"))
  if (data.verificationUri !== undefined && data.verificationUri !== githubVerificationUri)
    throw new Error(t("github.unsafeLink"))
  if (data.userCode !== undefined) {
    if (typeof data.userCode !== "string" || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(data.userCode))
      throw new Error(t("github.invalidCode"))
    if (data.verificationUri !== githubVerificationUri) throw new Error(t("github.missingLink"))
    if (data.status === "pending") {
      result.userCode = data.userCode
      result.verificationUri = githubVerificationUri
    }
  }
  if (data.account !== undefined) result.account = account(data.account)
  if (data.scopes !== undefined) result.scopes = scopes(data.scopes)
  if (data.status === "authorized" && (!result.account || !result.scopes))
    throw new Error(t("github.missingAccount"))
  if (data.receipt !== undefined) {
    if (data.status !== "completed") throw new Error(t("github.invalidReceipt"))
    result.receipt = receipt(data.receipt)
  }
  if (data.status === "completed" && !result.receipt) throw new Error(t("github.missingReceipt"))
  return result
}

/** Browser-safe local state only. Unknown fields, including raw errors, are not copied. */
export function parseGitHubConnection(value: unknown): GitHubConnection {
  const data = object(value)
  if (
    (data.secretStatus !== "ready" &&
      data.secretStatus !== "unavailable" &&
      data.secretStatus !== "locked") ||
    (data.mode !== "none" &&
      data.mode !== "manual" &&
      data.mode !== "oauth" &&
      data.mode !== "invalid") ||
    typeof data.reconnectRequired !== "boolean"
  )
    throw new Error(t("github.invalidConnection"))
  const application = parseGitHubApplication(data)
  const result: GitHubConnection = {
    revision: application.revision,
    applied: application.applied,
    status: application.status,
    secretStatus: data.secretStatus,
    mode: data.mode,
    reconnectRequired: data.reconnectRequired,
  }
  if (data.clientId !== undefined) {
    if (typeof data.clientId !== "string" || !/^[a-zA-Z0-9_.-]{1,128}$/.test(data.clientId))
      throw new Error(t("github.invalidClient"))
    result.clientId = data.clientId
  }
  if (data.account !== undefined) result.account = account(data.account)
  if (data.scopes !== undefined) result.scopes = scopes(data.scopes)
  if (data.expiresAt !== undefined) {
    result.expiresAt = integer(data.expiresAt)
    if (result.expiresAt > 8640000000000000) throw new Error(t("github.invalidExpiry"))
  }
  if (data.flow !== undefined) result.flow = parseGitHubFlow(data.flow)
  return result
}
