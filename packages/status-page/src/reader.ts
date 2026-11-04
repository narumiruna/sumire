import {
  getStatusProvider,
  parseStatusIncident,
  parseStatusSummary,
  type StatusIncident,
  type StatusProviderId,
  type StatusSummary,
  validateIncidentId,
} from "./status.js"

export interface StatusReadOptions {
  fetch?: typeof fetch
  signal?: AbortSignal
}

const responseLimit = 2 * 1024 * 1024

// An injected fetch or stream does not have to implement AbortSignal.
async function waitFor<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined
  try {
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    return await Promise.race([promise, aborted])
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

async function readJson(url: URL, options: StatusReadOptions): Promise<unknown> {
  options.signal?.throwIfAborted()
  const deadline = new AbortController()
  const signal = AbortSignal.any([deadline.signal, ...(options.signal ? [options.signal] : [])])
  const timer = setTimeout(
    () =>
      deadline.abort(new DOMException("Status request timed out after 15000 ms", "TimeoutError")),
    15_000,
  )
  timer.unref()
  let response: Response | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    response = await waitFor<Response>(
      (options.fetch ?? fetch)(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "omit",
        redirect: "error",
        signal,
      }).then((result) => {
        if (signal.aborted) {
          void result.body?.cancel().catch(() => {})
          signal.throwIfAborted()
        }
        return result
      }),
      signal,
    )
    signal.throwIfAborted()
    if (response.redirected) throw new Error("Status page redirects are not allowed")
    if (!response.ok) throw new Error(`Status page request failed (HTTP ${response.status})`)
    const length = response.headers.get("content-length")
    if (length && Number(length) > responseLimit)
      throw new Error("Status page response exceeds the 2 MiB limit")
    if (!response.body) throw new Error("Status page response has no body")
    reader = response.body.getReader()
    const decoder = new TextDecoder("utf-8", { fatal: true })
    const chunks: string[] = []
    let bytes = 0
    for (;;) {
      const { done, value } = await waitFor(reader.read(), signal)
      signal.throwIfAborted()
      if (done) break
      bytes += value.byteLength
      if (bytes > responseLimit) throw new Error("Status page response exceeds the 2 MiB limit")
      chunks.push(decoder.decode(value, { stream: true }))
    }
    const text = chunks.join("") + decoder.decode()
    signal.throwIfAborted()
    return JSON.parse(text) as unknown
  } finally {
    clearTimeout(timer)
    // Do not let an uncooperative stream's cancellation delay the deadline.
    if (reader) {
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    } else if (response?.body) {
      void response.body.cancel().catch(() => {})
    }
  }
}

export async function readStatusSummary(
  provider: StatusProviderId,
  options: StatusReadOptions = {},
): Promise<StatusSummary> {
  const entry = getStatusProvider(provider)
  const input = await readJson(new URL("/api/v2/summary.json", entry.url), options)
  return parseStatusSummary(provider, input)
}

export async function readStatusIncident(
  provider: StatusProviderId,
  incidentId: string,
  options: StatusReadOptions = {},
): Promise<StatusIncident> {
  const entry = getStatusProvider(provider)
  const id = validateIncidentId(incidentId)
  const input = await readJson(
    new URL(`/api/v2/incidents/${encodeURIComponent(id)}.json`, entry.url),
    options,
  )
  const incident = parseStatusIncident(provider, input)
  if (incident.id !== id) throw new Error("Status incident ID does not match the request")
  return incident
}
