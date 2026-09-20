import { spawn } from "node:child_process"

const childProgram = `
const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
try {
  const { formatFromBytes, formatFromPath, toMarkdownBytes } = await import("@firecrawl/anydoc")
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

export interface ConvertedDocument {
  markdown: string
  format: string
  originalChars: number
  truncated: boolean
}

export interface DocumentConverter {
  convert(bytes: Uint8Array, filename: string): Promise<ConvertedDocument>
}

interface AnyDocConverterOptions {
  timeoutMs: number
  maxMarkdownChars: number
  maxConcurrency: number
  run?: typeof runAnyDocChild
}

interface ChildSuccess {
  ok: true
  format: string | null
  markdown: string
  originalChars: number
  truncated: boolean
}

interface ChildFailure {
  ok: false
  code: string
  message: string
}

type ChildResult = ChildSuccess | ChildFailure

export class AnyDocConverter implements DocumentConverter {
  readonly #semaphore: Semaphore
  readonly #run: typeof runAnyDocChild

  private constructor(private readonly options: AnyDocConverterOptions) {
    this.#semaphore = new Semaphore(options.maxConcurrency)
    this.#run = options.run ?? runAnyDocChild
  }

  static async create(options: AnyDocConverterOptions): Promise<AnyDocConverter> {
    const adapter = await import("@firecrawl/anydoc")
    if (typeof adapter.toMarkdownBytes !== "function") {
      throw new Error("@firecrawl/anydoc did not expose toMarkdownBytes")
    }
    return new AnyDocConverter(options)
  }

  static forTesting(options: AnyDocConverterOptions): AnyDocConverter {
    return new AnyDocConverter(options)
  }

  async convert(bytes: Uint8Array, filename: string): Promise<ConvertedDocument> {
    if (bytes.byteLength === 0) {
      throw new DocumentConversionError("empty", "The document is empty")
    }
    const release = await this.#semaphore.acquire()
    try {
      const result = await this.#run(
        bytes,
        filename,
        this.options.maxMarkdownChars,
        this.options.timeoutMs,
      )
      if (!result.ok) throw normalizeFailure(result)
      if (!result.markdown.trim()) {
        throw new DocumentConversionError("empty", "The document produced no Markdown")
      }
      return {
        markdown: result.markdown,
        format: result.format ?? "unknown",
        originalChars: result.originalChars,
        truncated: result.truncated,
      }
    } finally {
      release()
    }
  }
}

export async function runAnyDocChild(
  bytes: Uint8Array,
  filename: string,
  maxMarkdownChars: number,
  timeoutMs: number,
): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", childProgram, "--", filename, String(maxMarkdownChars)],
      { stdio: ["pipe", "pipe", "pipe"] },
    )
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const maxStdoutBytes = Math.max(64_000, maxMarkdownChars * 8 + 4_096)
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let timedOut = false
    let processError: Error | undefined

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
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
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
            `Document converter exited with ${signal ?? code}${detail ? `: ${detail}` : ""}`,
          ),
        )
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString("utf8")) as ChildResult)
      } catch {
        reject(
          new DocumentConversionError("malformed", "Document converter returned invalid output"),
        )
      }
    })
    child.stdin.on("error", (error) => {
      if (!timedOut) finishWithError(error)
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

function normalizeFailure(result: ChildFailure): DocumentConversionError {
  const kinds = new Set<DocumentConversionErrorKind>([
    "unsupported",
    "needsOcr",
    "malformed",
    "encrypted",
    "resourceLimit",
    "missingPart",
  ])
  const kind = kinds.has(result.code as DocumentConversionErrorKind)
    ? (result.code as DocumentConversionErrorKind)
    : "malformed"
  return new DocumentConversionError(kind, result.message)
}

class Semaphore {
  #active = 0
  readonly #waiters: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.#active >= this.limit) {
      await new Promise<void>((resolve) => this.#waiters.push(resolve))
    }
    this.#active += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.#active -= 1
      this.#waiters.shift()?.()
    }
  }
}
