export const SAMPLE_RATE = 16_000
export const MAX_CONTROL_BYTES = 1024 * 1024
export const DEFAULT_MODEL = "Xenova/whisper-tiny"
export const DEFAULT_REVISION = "5332fcc35e32a33b86612b9a57a89be7906102b1"

export type AudioPhase = "decode" | "model_load" | "inference"
export type AudioErrorKind =
  | "dependency_missing"
  | "media_duration_limit"
  | "transcription_failed"
  | "empty_content"
export type AudioDependency = "ffmpeg" | "@huggingface/transformers"

const messages: Record<AudioErrorKind, string> = {
  dependency_missing: "An audio transcription dependency is unavailable",
  media_duration_limit: "Decoded audio exceeds the duration limit",
  transcription_failed: "Audio transcription failed",
  empty_content: "Audio transcription produced no text",
}

/** Contains safe facts only. Do not attach native errors, paths, or stderr. */
export class AudioTranscriptionError extends Error {
  constructor(
    readonly kind: AudioErrorKind,
    readonly phase: AudioPhase,
    readonly dependency?: AudioDependency,
    readonly limit?: number,
    readonly observed?: number,
  ) {
    super(messages[kind])
    this.name = "AudioTranscriptionError"
  }
}

export interface TranscribeAudioOptions {
  signal?: AbortSignal
  maxDurationSeconds: number
  model?: string
  onPhase?: (phase: AudioPhase) => void
}

export type TranscribeAudioFile = (path: string, options: TranscribeAudioOptions) => Promise<string>

export function resolveAudioModel(model = "tiny"): string {
  if (model === "tiny" || model === DEFAULT_MODEL) return DEFAULT_MODEL
  if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/u.test(model)) {
    throw new AudioTranscriptionError("transcription_failed", "model_load")
  }
  return model
}

/** The PCM file is private to this request; PCM never enters the control channel. */
export interface AudioRequest {
  type: "transcribe"
  path: string
  samples: number
  model: string
}

/** Each frame, including its newline, is bounded independently of decoded PCM. */
export function encodeAudioMessage(message: unknown): string {
  const frame = `${JSON.stringify(message)}\n`
  if (Buffer.byteLength(frame) > MAX_CONTROL_BYTES) {
    throw new AudioTranscriptionError("transcription_failed", "inference")
  }
  return frame
}

/** Accept at most one bounded frame at a time, including across stream chunks. */
export class AudioMessageReader {
  private pending = Buffer.alloc(0)

  push(chunk: Buffer, receive: (message: unknown) => void): void {
    let start = 0
    for (;;) {
      const end = chunk.indexOf(10, start)
      const part = chunk.subarray(start, end < 0 ? chunk.length : end + 1)
      if (this.pending.length + part.length > MAX_CONTROL_BYTES) {
        throw new AudioTranscriptionError("transcription_failed", "inference")
      }
      this.pending = Buffer.concat([this.pending, part])
      if (end < 0) return
      const message: unknown = JSON.parse(this.pending.toString("utf8"))
      this.pending = Buffer.alloc(0)
      receive(message)
      start = end + 1
      if (start === chunk.length) return
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
