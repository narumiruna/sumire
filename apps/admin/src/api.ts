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
export function parseIds(value: string, positive: boolean) {
  const result = value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
  if (result.some((id) => !Number.isSafeInteger(id) || (positive ? id <= 0 : id >= 0)))
    throw new Error("Enter valid Telegram IDs")
  return [...new Set(result)]
}
