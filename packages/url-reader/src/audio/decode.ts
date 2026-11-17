import { spawn } from "node:child_process"
import { createWriteStream } from "node:fs"
import { isAbsolute } from "node:path"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { audioProcessClosed, stopAudioProcess } from "./process.js"
import { AudioTranscriptionError, SAMPLE_RATE } from "./protocol.js"

/** Decode a local file without truncation. Limits apply to bytes as they arrive. */
export async function decodeAudioFile(
  input: string,
  output: string,
  maxDurationSeconds: number,
  signal: AbortSignal,
): Promise<number> {
  signal.throwIfAborted()
  const maxSamples = Math.floor(maxDurationSeconds * SAMPLE_RATE)
  if (!isAbsolute(input) || !Number.isSafeInteger(maxSamples) || maxSamples <= 0) {
    throw new AudioTranscriptionError("transcription_failed", "decode")
  }
  const maxBytes = maxSamples * Float32Array.BYTES_PER_ELEMENT
  if (!Number.isSafeInteger(maxBytes)) {
    throw new AudioTranscriptionError("transcription_failed", "decode")
  }
  const child = spawn(
    "ffmpeg",
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      input,
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-ac",
      "1",
      "-ar",
      String(SAMPLE_RATE),
      "-c:a",
      "pcm_f32le",
      "-f",
      "f32le",
      "pipe:1",
    ],
    { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
  )
  const closed = audioProcessClosed(child)
  let failure: unknown
  let bytes = 0
  let stopping: Promise<void> | undefined
  const stop = () => (stopping ??= stopAudioProcess(child, closed))
  const abort = () => {
    failure = signal.reason
    void stop()
  }
  child.on("error", (error: NodeJS.ErrnoException) => {
    failure = new AudioTranscriptionError(
      error.code === "ENOENT" ? "dependency_missing" : "transcription_failed",
      "decode",
      error.code === "ENOENT" ? "ffmpeg" : undefined,
    )
  })
  signal.addEventListener("abort", abort, { once: true })
  if (signal.aborted) abort()
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length
      if (bytes > maxBytes) {
        failure = new AudioTranscriptionError(
          "media_duration_limit",
          "decode",
          undefined,
          maxDurationSeconds,
          bytes / Float32Array.BYTES_PER_ELEMENT / SAMPLE_RATE,
        )
        void stop()
        callback(failure as Error)
      } else {
        callback(null, chunk)
      }
    },
  })
  try {
    await pipeline(child.stdout, guard, createWriteStream(output, { flags: "wx", mode: 0o600 }))
    const code = await closed
    if (signal.aborted) throw signal.reason
    if (failure) throw failure
    if (code !== 0 || bytes === 0 || bytes % Float32Array.BYTES_PER_ELEMENT !== 0) {
      throw new AudioTranscriptionError("transcription_failed", "decode")
    }
    return bytes / Float32Array.BYTES_PER_ELEMENT
  } catch {
    await stop()
    if (signal.aborted) throw signal.reason
    throw failure ?? new AudioTranscriptionError("transcription_failed", "decode")
  } finally {
    signal.removeEventListener("abort", abort)
    await stopping
    await closed
  }
}
