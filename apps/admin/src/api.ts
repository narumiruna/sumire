import type { Policy, ProviderSettings, Selection } from "../../bot/src/admin/policy.js"

export type { Policy, ProviderSettings, Selection }
export type Snapshot = { revision: number; applied: number; status: string; policy: Policy }
export interface Inventory {
  tools: string[]
  providers: {
    id: string
    name: string
    configured: boolean
    apiKey: boolean
    oauth: boolean
    models: { id: string; name: string; thinking: string[]; reasoning: boolean; image: boolean }[]
  }[]
  mcp: {
    name: string
    connection: string
    tools: string[]
    fields?: string[]
    enabled?: boolean
    exposure?: string
    env: Record<string, null>
    headers: Record<string, null>
  }[]
}
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
): Promise<T> {
  const response = await fetch(
    `/api/${path}`,
    csrf
      ? {
          method,
          credentials: "same-origin",
          headers: { "content-type": "application/json", "x-csrf-token": csrf },
          body: JSON.stringify(value ?? {}),
        }
      : { credentials: "same-origin" },
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
