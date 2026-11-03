import { spawn } from "node:child_process"

const childProgram = `
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
try {
  const { formatFromBytes, formatFromPath, toMarkdownBytes } = await import(process.argv[3])
  const bytes = Buffer.concat(chunks)
  const filename = process.argv[1] || ""
  const maxChars = Number(process.argv[2])
  const format = formatFromBytes(bytes) ?? formatFromPath(filename)
  const markdown = await toMarkdownBytes(bytes, format, { ocr: "reject" })
  const truncated = markdown.length > maxChars
  process.stdout.write(JSON.stringify({
    ok: true,
    format,
    markdown: truncated ? markdown.slice(0, maxChars) : markdown,
    originalChars: markdown.length,
    truncated,
  }))
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    code: typeof error?.code === "string" ? error.code : "malformed",
    message: error instanceof Error ? error.message : String(error),
  }))
}
`

export type DocumentConversionErrorKind =
  | "unsupported"
  | "needsOcr"
  | "malformed"
  | "encrypted"
  | "resourceLimit"
  | "missingPart"
  | "timeout"
  | "empty"

export class DocumentConversionError extends Error {
  constructor(
    readonly kind: DocumentConversionErrorKind,
    message: string,
  ) {
    super(message)
    this.name = "DocumentConversionError"
  }
}

export interface AnyDocSuccess {
  ok: true
  format: string | null
  markdown: string
  originalChars: number
  truncated: boolean
}

export interface AnyDocFailure {
  ok: false
  code: string
  message: string
}

export type AnyDocResult = AnyDocSuccess | AnyDocFailure

/** Convert bytes locally; aborts and failures settle only after the child closes. */
export async function runAnyDocChild(
  bytes: Uint8Array,
  filename: string,
  maxMarkdownChars: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<AnyDocResult> {
  if (signal?.aborted) throw signal.reason
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        childProgram,
        "--",
        filename,
        String(maxMarkdownChars),
        // Resolve from this package, not the caller's working directory.
        import.meta.resolve("@firecrawl/anydoc"),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    )
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const maxStdoutBytes = Math.max(64_000, maxMarkdownChars * 8 + 4_096)
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let timedOut = false
    let aborted = false
    let processError: Error | undefined

    const onAbort = () => {
      aborted = true
      child.kill("SIGKILL")
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)
    timer.unref()

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > maxStdoutBytes) {
        child.kill("SIGKILL")
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= 8_192) return
      stderrBytes += chunk.byteLength
      stderr.push(chunk.subarray(0, Math.max(0, 8_192 - (stderrBytes - chunk.byteLength))))
    })
    child.on("error", finishWithError)
    child.on("close", (code, exitSignal) => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      if (settled) return
      settled = true
      if (aborted) {
        reject(signal?.reason)
        return
      }
      if (timedOut) {
        reject(new DocumentConversionError("timeout", "Document conversion timed out"))
        return
      }
      if (processError) {
        reject(processError)
        return
      }
      if (stdoutBytes > maxStdoutBytes) {
        reject(
          new DocumentConversionError("resourceLimit", "Document conversion output was too large"),
        )
        return
      }
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim()
        reject(
          new DocumentConversionError(
            "malformed",
            `Document converter exited with ${exitSignal ?? code}${detail ? `: ${detail}` : ""}`,
          ),
        )
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")) as AnyDocResult)
      } catch {
        reject(
          new DocumentConversionError("malformed", "Document converter returned invalid output"),
        )
      }
    })
    child.stdin.on("error", (error) => {
      if (!timedOut && !aborted) finishWithError(error)
    })
    child.stdin.end(Buffer.from(bytes))

    function finishWithError(error: Error): void {
      if (settled || processError) return
      processError = error
      child.kill("SIGKILL")
      // Keep conversion capacity until close confirms that the child has stopped.
    }
  })
}
