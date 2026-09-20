export type MarketFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const maxResponseBytes = 2 * 1024 * 1024
const requestTimeoutMs = 10_000

export async function requestJson(
  url: string | URL,
  fetchImplementation: MarketFetch = globalThis.fetch,
): Promise<unknown> {
  const response = await fetchImplementation(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(requestTimeoutMs),
  })
  if (!response.ok) throw new Error(`Market-data request failed (${response.status})`)
  const contentLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    throw new Error("Market-data response is too large")
  }
  const body = await response.text()
  if (Buffer.byteLength(body) > maxResponseBytes)
    throw new Error("Market-data response is too large")
  return JSON.parse(body) as unknown
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return undefined
  const number = typeof value === "number" ? value : Number(value)
  return Number.isFinite(number) ? number : undefined
}

export function text(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined
  return Array.from(value.trim()).slice(0, 300).join("")
}
