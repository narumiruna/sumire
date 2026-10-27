import type { Snapshot } from "@narumitw/sumire-contracts"
import { type Policy, policySchema } from "@narumitw/sumire-policy"

export type { AuditEntry, ChatResponse, Snapshot } from "@narumitw/sumire-contracts"
export type { Policy } from "@narumitw/sumire-policy"
export type Session = { csrf: string; actor: string }

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** The bot serves the API at the origin root; v2 shares it with v1. */
export async function request<T>(
  path: string,
  write?: { csrf: string; method?: "POST" | "PUT" | "DELETE"; value?: unknown },
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(
    `/api/${path}`,
    write
      ? {
          method: write.method ?? "POST",
          signal,
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-csrf-token": write.csrf },
          body: JSON.stringify(write.value ?? {}),
        }
      : { credentials: "same-origin", signal },
  )
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiError(response.status, data.error ?? "Request failed")
  return data as T
}

/** Verify revision, application, and policy fields before using a settings response as a save base. */
export function parseSnapshot(value: unknown): Snapshot {
  const snapshot = value as Snapshot | null
  if (
    !snapshot ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 1 ||
    !Number.isSafeInteger(snapshot.applied) ||
    snapshot.applied < 0 ||
    typeof snapshot.status !== "string" ||
    !snapshot.status
  )
    throw new Error("Could not verify saved settings. Reload before another save.")
  const policy = policySchema.safeParse(snapshot.policy)
  if (!policy.success)
    throw new Error("Saved settings are not in a shape this console understands. Reload the page.")
  return { ...snapshot, policy: policy.data }
}

export async function loadSettings(signal?: AbortSignal) {
  return parseSnapshot(await request<unknown>("settings", undefined, signal))
}

/** Save a whole policy against the revision it was derived from; the server applies it. */
export async function saveSettings(csrf: string, revision: number, policy: Policy) {
  return parseSnapshot(
    await request<unknown>("settings", { csrf, method: "PUT", value: { revision, policy } }),
  )
}

export function errorMessage(error: unknown) {
  if (error instanceof ApiError && error.status === 409)
    return "Settings changed since this page loaded. Reload, then try again."
  if (error instanceof ApiError && error.status === 401)
    return "Your administrator session ended. Sign in again."
  return error instanceof Error ? error.message : "Request failed"
}
