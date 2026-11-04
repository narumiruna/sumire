import type { ServiceStatusDiagnostic } from "@narumitw/sumire-contracts"
import { AdminError } from "../admin/store.js"

/** Bound an injected operation as well as transports that implement AbortSignal. */
export async function withStatusSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined
  try {
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
    })
    return await Promise.race([work, cancelled])
  } finally {
    if (abort) signal.removeEventListener("abort", abort)
  }
}

/** Use structured error fields, never provider messages or warning text. */
export function statusDiagnostic(error: unknown): ServiceStatusDiagnostic {
  if (error instanceof AdminError && [401, 409, 503].includes(error.status)) return "cancelled"
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "timeout"
    if (error.name === "AbortError") return "cancelled"
  }
  if (error && typeof error === "object" && "error_code" in error) {
    if (error.error_code === 403) return "forbidden"
    if (error.error_code === 400) return "chat_unavailable"
    if (error.error_code === 429) return "rate_limited"
  }
  return "delivery_failed"
}
