import {
  type AnyDocFailure,
  DocumentConversionError,
  type DocumentConversionErrorKind,
  runAnyDocChild,
} from "@narumitw/sumire-url-content/anydoc"

export {
  DocumentConversionError,
  type DocumentConversionErrorKind,
  runAnyDocChild,
} from "@narumitw/sumire-url-content/anydoc"

export interface ConvertedDocument {
  markdown: string
  format: string
  originalChars: number
  truncated: boolean
}

export interface DocumentConverter {
  // Load bytes only after admission so queued jobs do not retain downloaded input.
  convert(loadBytes: () => Promise<Uint8Array>, filename: string): Promise<ConvertedDocument>
}

interface AnyDocConverterOptions {
  timeoutMs: number
  maxMarkdownChars: number
  maxConcurrency: number
  run?: typeof runAnyDocChild
}

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

  async convert(
    loadBytes: () => Promise<Uint8Array>,
    filename: string,
  ): Promise<ConvertedDocument> {
    const release = await this.#semaphore.acquire()
    try {
      const bytes = await loadBytes()
      if (bytes.byteLength === 0) {
        throw new DocumentConversionError("empty", "The document is empty")
      }
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

function normalizeFailure(result: AnyDocFailure): DocumentConversionError {
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
    } else {
      this.#active += 1
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.#waiters.shift()
      if (next) next()
      else this.#active -= 1
    }
  }
}
