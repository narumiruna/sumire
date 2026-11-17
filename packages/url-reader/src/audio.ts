import { AsyncResource } from "node:async_hooks"
import { type ChildProcessByStdio, spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import type { Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Readable, Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import { decodeAudioFile } from "./audio/decode.js"
import { audioProcessClosed, stopAudioProcess } from "./audio/process.js"
import {
  AudioMessageReader,
  type AudioPhase,
  type AudioRequest,
  AudioTranscriptionError,
  encodeAudioMessage,
  isRecord,
  resolveAudioModel,
  type TranscribeAudioFile,
  type TranscribeAudioOptions,
} from "./audio/protocol.js"

export type {
  AudioDependency,
  AudioErrorKind,
  AudioPhase,
  TranscribeAudioFile,
  TranscribeAudioOptions,
} from "./audio/protocol.js"
export { AudioTranscriptionError }

type InferenceProcess = ChildProcessByStdio<Writable, Readable, null>
interface InferenceChild {
  process: InferenceProcess
  closed: Promise<number | null>
  stopping?: Promise<void>
  failed?: AudioTranscriptionError
  onMessage?: (message: unknown) => void
  onFailure?: (error: AudioTranscriptionError) => void
}

function referenceChild(worker: InferenceChild, referenced: boolean): void {
  const child = worker.process
  if (referenced) {
    child.ref()
    ;(child.stdin as Socket).ref()
    ;(child.stdout as Socket).ref()
    child.channel?.ref()
  } else {
    child.unref()
    ;(child.stdin as Socket).unref()
    ;(child.stdout as Socket).unref()
    child.channel?.unref()
  }
}

function awaitAdmission(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    void previous.then(() => {
      signal.removeEventListener("abort", abort)
      if (signal.aborted) reject(signal.reason)
      else resolve()
    })
  })
}

/** One service owns one admission slot and one lazily cached inference process. */
export class AudioTranscriberService {
  private tail = Promise.resolve()
  private readonly scopes = new Set<AbortController>()
  private worker?: InferenceChild
  private closed = false
  private closing?: Promise<void>

  /** The alternate entry point is for local fixture tests, not runtime configuration. */
  constructor(private readonly childEntry = new URL("./audio/child.js", import.meta.url)) {}

  async withTranscriber<T>(
    operation: (transcribe: TranscribeAudioFile, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted()
    if (this.closed) throw new AudioTranscriptionError("transcription_failed", "decode")
    const scope = new AbortController()
    const activeSignal = signal ? AbortSignal.any([signal, scope.signal]) : scope.signal
    this.scopes.add(scope)
    const previous = this.tail
    let release = () => {}
    const complete = new Promise<void>((resolve) => {
      release = resolve
    })
    this.tail = previous.then(() => complete)
    let usable = true
    let running: Promise<string> | undefined
    const transcribe: TranscribeAudioFile = async (path, options) => {
      if (!usable || running) {
        throw new AudioTranscriptionError("transcription_failed", "decode")
      }
      const pending = this.transcribeFile(path, options, activeSignal)
      running = pending
      try {
        return await pending
      } finally {
        running = undefined
      }
    }
    try {
      await awaitAdmission(previous, activeSignal)
      activeSignal.throwIfAborted()
      const result = await operation(transcribe, activeSignal)
      activeSignal.throwIfAborted()
      return result
    } finally {
      usable = false
      scope.abort(new AudioTranscriptionError("transcription_failed", "decode"))
      await running?.catch(() => {})
      this.scopes.delete(scope)
      release()
    }
  }

  close(): Promise<void> {
    this.closing ??= this.dispose()
    return this.closing
  }

  private async dispose(): Promise<void> {
    this.closed = true
    for (const scope of this.scopes) {
      scope.abort(new AudioTranscriptionError("transcription_failed", "decode"))
    }
    await this.tail
    const worker = this.worker
    if (!worker) return
    referenceChild(worker, true)
    // Give a warm pipeline time to dispose. Never depend on cooperative native cancellation.
    const timer = setTimeout(() => worker.process.kill("SIGKILL"), 1000)
    try {
      worker.process.stdin.write(encodeAudioMessage({ type: "dispose" }))
      await worker.closed
    } finally {
      clearTimeout(timer)
    }
  }

  private async transcribeFile(
    path: string,
    options: TranscribeAudioOptions,
    scopeSignal: AbortSignal,
  ): Promise<string> {
    const signal = options.signal ? AbortSignal.any([scopeSignal, options.signal]) : scopeSignal
    signal.throwIfAborted()
    const model = resolveAudioModel(options.model)
    // Persistent stream listeners retain their creation context. Restore this request's context.
    const onPhase = AsyncResource.bind((next: AudioPhase) => options.onPhase?.(next))
    let phase: AudioPhase = "decode"
    let directory: string | undefined
    try {
      onPhase("decode")
      signal.throwIfAborted()
      directory = await mkdtemp(join(tmpdir(), "sumire-audio-"))
      const pcmPath = join(directory, "audio.f32")
      const samples = await decodeAudioFile(path, pcmPath, options.maxDurationSeconds, signal)
      signal.throwIfAborted()
      const worker = this.getChild()
      return await this.infer(
        worker,
        { type: "transcribe", path: pcmPath, samples, model },
        signal,
        (next) => {
          phase = next
          onPhase(next)
        },
      )
    } catch (error) {
      if (signal.aborted) throw signal.reason
      if (error instanceof AudioTranscriptionError) throw error
      throw new AudioTranscriptionError("transcription_failed", phase)
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true })
    }
  }

  private getChild(): InferenceChild {
    if (this.worker) return this.worker
    const child = spawn(process.execPath, [fileURLToPath(this.childEntry)], {
      stdio: ["pipe", "pipe", "ignore", "ipc"],
      windowsHide: true,
    }) as InferenceProcess
    const worker: InferenceChild = { process: child, closed: audioProcessClosed(child) }
    this.worker = worker
    const exit = () => child.kill("SIGKILL")
    process.once("exit", exit)
    const fail = () => {
      worker.failed ??= new AudioTranscriptionError("transcription_failed", "model_load")
      worker.onFailure?.(worker.failed)
      void this.stopChild(worker)
    }
    child.on("error", fail)
    child.stdin.on("error", fail)
    child.stdout.on("error", fail)
    const reader = new AudioMessageReader()
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        reader.push(chunk, (message) => {
          if (!worker.onMessage) throw new Error("Unexpected audio control message")
          worker.onMessage(message)
        })
      } catch {
        fail()
      }
    })
    void worker.closed.then(() => {
      process.removeListener("exit", exit)
      if (this.worker === worker) this.worker = undefined
      worker.failed ??= new AudioTranscriptionError("transcription_failed", "model_load")
      worker.onFailure?.(worker.failed)
    })
    return worker
  }

  private stopChild(worker: InferenceChild): Promise<void> {
    worker.stopping ??= stopAudioProcess(worker.process, worker.closed)
    return worker.stopping
  }

  private async infer(
    worker: InferenceChild,
    request: AudioRequest,
    signal: AbortSignal,
    onPhase: (phase: AudioPhase) => void,
  ): Promise<string> {
    referenceChild(worker, true)
    let phase: AudioPhase = "decode"
    let abort = () => {}
    try {
      return await new Promise<string>((resolve, reject) => {
        const fail = (error: unknown) => {
          void this.stopChild(worker).then(() => reject(signal.aborted ? signal.reason : error))
        }
        abort = () => fail(signal.reason)
        worker.onFailure = () => {
          fail(new AudioTranscriptionError("transcription_failed", phase))
        }
        worker.onMessage = (message) => {
          if (!isRecord(message)) throw new Error("Invalid audio control message")
          if (
            message.type === "phase" &&
            ((phase === "decode" && message.phase === "model_load") ||
              (phase === "model_load" && message.phase === "inference"))
          ) {
            phase = message.phase
            onPhase(phase)
            signal.throwIfAborted()
            worker.process.stdin.write(encodeAudioMessage({ type: "continue", phase }))
          } else if (message.type === "result" && phase === "inference") {
            if (typeof message.text !== "string") throw new Error("Invalid audio result")
            if (!message.text.trim()) {
              fail(new AudioTranscriptionError("empty_content", phase))
            } else {
              resolve(message.text.trim())
            }
          } else if (message.type === "error" && message.phase === phase) {
            if (
              message.kind !== "transcription_failed" &&
              message.kind !== "empty_content" &&
              message.kind !== "dependency_missing"
            ) {
              throw new Error("Invalid audio failure")
            }
            fail(
              new AudioTranscriptionError(
                message.kind,
                phase,
                message.kind === "dependency_missing" &&
                  message.dependency === "@huggingface/transformers"
                  ? "@huggingface/transformers"
                  : undefined,
              ),
            )
          } else {
            throw new Error("Invalid audio control message")
          }
        }
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
        else if (worker.failed) worker.onFailure(worker.failed)
        else worker.process.stdin.write(encodeAudioMessage(request))
      })
    } catch (error) {
      await this.stopChild(worker)
      throw error
    } finally {
      signal.removeEventListener("abort", abort)
      worker.onMessage = undefined
      worker.onFailure = undefined
      referenceChild(worker, false)
    }
  }
}

let sharedService: AudioTranscriberService | undefined

/** Admission includes the caller's download and temporary-file cleanup. */
export function withAudioTranscriber<T>(
  operation: (transcribe: TranscribeAudioFile, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  sharedService ??= new AudioTranscriberService()
  return sharedService.withTranscriber(operation, signal)
}

export async function closeAudioTranscriber(): Promise<void> {
  const service = sharedService
  if (!service) return
  await service.close()
  if (sharedService === service) sharedService = undefined
}
