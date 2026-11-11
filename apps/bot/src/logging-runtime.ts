import { DiagLogLevel, diag } from "@opentelemetry/api"
import type { SpanAttributes } from "./logging.js"
import { errorAttributes } from "./logging-attributes.js"

const sdkEvents = [
  "SIGTERM",
  "beforeExit",
  "uncaughtExceptionMonitor",
  "unhandledRejection",
] as const

let releaseCurrentOwner: (() => void) | undefined

/** stderr-only, fixed identifiers, no SDK text, no recursive telemetry writes. */
export function createLocalDiagnostics(
  write: (message: string, attributes: SpanAttributes) => void,
): (event: string, error?: unknown) => void {
  let count = 0
  let windowStarted = Date.now()
  let writing = false
  return (event, error) => {
    const now = Date.now()
    if (now - windowStarted >= 60_000) {
      count = 0
      windowStarted = now
    }
    if (writing || count > 10) return
    writing = true
    try {
      count++
      write(count === 11 ? "telemetry.diagnostics.suppressed" : event, {
        "telemetry.diagnostic_count": count,
        ...(count === 11 ? {} : errorAttributes(error)),
      })
    } catch {
      // A closed stderr must not fail business work or recurse through diag.
    } finally {
      writing = false
    }
  }
}

export function ownSdkRuntime(options: {
  configure: () => void
  diagnose: (event: string, error?: unknown) => void
  reportProcessError: (event: string, error: unknown) => void
  flush: () => Promise<void>
  deactivate: () => void
}): () => void {
  releaseCurrentOwner?.()
  const { diagnose } = options
  // The public diag API has no getter. This process uses one application-owned
  // SDK and diagnostic logger. Do not forward SDK text or arbitrary arguments.
  diag.setLogger(
    {
      error: (_message, ...args) => diagnose("telemetry.sdk.error", args.find(isError)),
      warn: (_message, ...args) => diagnose("telemetry.sdk.warning", args.find(isError)),
      info() {},
      debug() {},
      verbose() {},
    },
    { logLevel: DiagLogLevel.WARN, suppressOverrideMessage: true },
  )
  const before = sdkEvents.map((event) => new Set(process.listeners(event)))
  try {
    options.configure()
  } catch (error) {
    diag.disable()
    throw error
  } finally {
    // SDK 0.23 has no public switch for these hooks. configure() adds them
    // synchronously. Remove only newly added identities, including on failure.
    for (const [index, event] of sdkEvents.entries()) {
      for (const listener of process.listeners(event)) {
        if (!before[index]?.has(listener)) process.removeListener(event, listener)
      }
    }
  }

  const flush = () => {
    try {
      void options.flush().catch((error) => diagnose("telemetry.flush.failed", error))
    } catch (error) {
      diagnose("telemetry.flush.failed", error)
    }
  }
  const uncaught = (error: unknown) => {
    options.reportProcessError("process.uncaught_exception", error)
    flush()
  }
  const rejected = (error: unknown) => {
    // Preserve SDK 0.23's observe-and-continue policy for unhandled rejections.
    // The monitor below does not suppress Node's fatal uncaught-exception path.
    options.reportProcessError("process.unhandled_rejection", error)
    flush()
  }
  process.on("uncaughtExceptionMonitor", uncaught)
  process.on("unhandledRejection", rejected)
  const release = () => {
    process.removeListener("uncaughtExceptionMonitor", uncaught)
    process.removeListener("unhandledRejection", rejected)
    options.deactivate()
    if (releaseCurrentOwner === release) {
      releaseCurrentOwner = undefined
      diag.disable()
    }
  }
  releaseCurrentOwner = release
  return release
}

function isError(value: unknown): boolean {
  return value !== null && typeof value === "object"
}
