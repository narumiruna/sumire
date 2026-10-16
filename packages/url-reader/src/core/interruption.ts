import type { AttemptRecord } from "./results.js"

// Preserve the caller's cancellation reason and identity without mutating it.
const interruptedAttempts = new WeakMap<object, Map<string, readonly AttemptRecord[]>>()

export function retainInterruptedAttempts(
  error: unknown,
  attempts: readonly AttemptRecord[],
  url: string,
): void {
  if (typeof error !== "object" || error === null) return
  const records = interruptedAttempts.get(error) ?? new Map<string, readonly AttemptRecord[]>()
  records.set(url, [...attempts])
  interruptedAttempts.set(error, records)
}

export function getInterruptedAttempts(
  error: unknown,
  url?: string,
): readonly AttemptRecord[] | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const records = interruptedAttempts.get(error)
  // A shared signal can interrupt several URLs with the same reason object.
  return url === undefined ? [...(records?.values() ?? [])].at(-1) : records?.get(url)
}

/** Bound waiting, signal cooperative cleanup, and remove our timer/listener on every outcome. */
export async function runBounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number | undefined,
  signal?: AbortSignal,
  timeoutReason: unknown = new DOMException("Deadline expired", "TimeoutError"),
): Promise<T> {
  if (signal?.aborted) throw signal.reason
  const controller = new AbortController()
  const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => reject(active.reason)
      active.addEventListener("abort", onAbort, { once: true })
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => controller.abort(timeoutReason), Math.max(0, timeoutMs))
      }
      Promise.resolve()
        .then(() => {
          active.throwIfAborted()
          return operation(active)
        })
        .then(resolve, reject)
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort) active.removeEventListener("abort", onAbort)
  }
}
