import type { Snapshot } from "@narumitw/sumire-contracts"
import { policySchema } from "@narumitw/sumire-policy"

export type { Inventory, Snapshot } from "@narumitw/sumire-contracts"
export type { Policy, ProviderSettings, Selection } from "@narumitw/sumire-policy"

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
export async function request<T>(
  path: string,
  csrf?: string,
  value?: unknown,
  method = "POST",
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(
    `/api/${path}`,
    csrf
      ? {
          method,
          signal,
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-csrf-token": csrf },
          body: JSON.stringify(value ?? {}),
        }
      : { credentials: "same-origin", signal },
  )
  const data = await response.json()
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
    throw new Error(
      "Could not verify saved settings. Load the latest settings before another save.",
    )
  return { ...snapshot, policy: policySchema.parse(snapshot.policy) }
}

export function parseIds(value: string, positive: boolean) {
  const result = value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
  if (result.some((id) => !Number.isSafeInteger(id) || (positive ? id <= 0 : id >= 0)))
    throw new Error("Enter valid Telegram IDs")
  return [...new Set(result)]
}
