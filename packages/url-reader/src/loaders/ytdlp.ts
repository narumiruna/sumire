import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  FailureDiagnosticError,
  LoaderContentError,
  LoaderTimeoutError,
  MissingDependencyError,
} from "../core/errors.js"
import type { Loader } from "../core/loader.js"
import { parseYouTubeVideoTarget, requireLoaderApplicability } from "../sources/applicability.js"

interface CommandResult {
  stdout: string
  stderr: string
}

type CommandRunner = (
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<CommandResult>

export const DEFAULT_YTDLP_DOWNLOAD_TIMEOUT_MS = 120_000
export const DEFAULT_WHISPER_TIMEOUT_MS = 300_000
export const DEFAULT_MAX_MEDIA_BYTES = 100 * 1024 * 1024
export const DEFAULT_MAX_MEDIA_DURATION_SECONDS = 3_600
export const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024

export const runCommand: CommandRunner = (command, args, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const detached = process.platform !== "win32"
    const child = spawn(command, args, { detached, stdio: ["ignore", "pipe", "pipe"] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let childClosed = false
    let killTimer: NodeJS.Timeout | undefined
    let settled = false
    let stopped = false
    let stopReason: unknown
    let outputBytes = 0
    const kill = (signalName: NodeJS.Signals) => {
      try {
        if (detached && child.pid) process.kill(-child.pid, signalName)
        else child.kill(signalName)
      } catch {
        // The process has already exited.
      }
    }
    const processGroupExists = (): boolean => {
      if (!detached || !child.pid) return false
      try {
        process.kill(-child.pid, 0)
        return true
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
        return true
      }
    }
    const finish = (operation: () => void) => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", onAbort)
      if (killTimer) clearTimeout(killTimer)
      operation()
    }
    const finishStopped = () => finish(() => reject(stopReason))
    const stop = (reason: unknown) => {
      if (stopped) return
      stopped = true
      stopReason = reason
      kill("SIGTERM")
      killTimer = setTimeout(() => {
        killTimer = undefined
        kill("SIGKILL")
        if (childClosed) finishStopped()
      }, 1_000)
    }
    const onAbort = () => stop(signal?.reason)
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) onAbort()
    const collect = (target: Buffer[], chunk: Buffer) => {
      if (stopped) return
      outputBytes += chunk.length
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        stop(new Error("Command output limit exceeded"))
        return
      }
      target.push(chunk)
    }
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk))
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk))
    child.once("error", (error) => finish(() => reject(error)))
    child.once("close", (code) => {
      childClosed = true
      if (stopped) {
        if (killTimer && processGroupExists()) return
        finishStopped()
        return
      }
      finish(() => {
        const result = {
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        }
        if (code === 0) resolve(result)
        else reject(new Error("External command failed"))
      })
    })
  })

export class YtdlpLoader implements Loader {
  constructor(
    private readonly options: {
      model?: string
      ytdlpPath?: string
      whisperPath?: string
      downloadTimeoutMs?: number
      transcriptionTimeoutMs?: number
      maxMediaBytes?: number
      maxDurationSeconds?: number
      commandRunner?: CommandRunner
    } = {},
  ) {
    for (const value of [
      options.downloadTimeoutMs,
      options.transcriptionTimeoutMs,
      options.maxMediaBytes,
      options.maxDurationSeconds,
    ]) {
      if (
        value !== undefined &&
        (!Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER)
      ) {
        throw new RangeError("Media limits and timeouts must be positive finite safe numbers")
      }
    }
  }

  async load(url: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const maxMediaBytes = this.options.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES
    const maxDurationSeconds = this.options.maxDurationSeconds ?? DEFAULT_MAX_MEDIA_DURATION_SECONDS
    const downloadTimeoutMs = this.options.downloadTimeoutMs ?? DEFAULT_YTDLP_DOWNLOAD_TIMEOUT_MS
    const transcriptionTimeoutMs = this.options.transcriptionTimeoutMs ?? DEFAULT_WHISPER_TIMEOUT_MS
    const downloadTimeout = AbortSignal.timeout(downloadTimeoutMs)
    const downloadSignal = signal ? AbortSignal.any([signal, downloadTimeout]) : downloadTimeout
    const directory = await mkdtemp(join(tmpdir(), "sumire-url-reader-audio-"))
    const audioPath = join(directory, "audio.mp3")
    let transcriptionTimeout: AbortSignal | undefined
    let phase: "metadata" | "download" | "transcription" = "metadata"
    const commandRunner = this.options.commandRunner ?? runCommand
    const run = async (
      command: string,
      args: readonly string[],
      activeSignal: AbortSignal,
      dependency: "yt-dlp" | "whisper",
    ) => {
      activeSignal.throwIfAborted()
      try {
        const result = await commandRunner(command, args, activeSignal)
        activeSignal.throwIfAborted()
        return result
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          throw new MissingDependencyError("ytdlp", dependency, "Install the required tool.", {
            code: "dependency_missing",
            phase,
            dependency,
          })
        }
        throw error
      }
    }
    try {
      const ytdlp = this.options.ytdlpPath ?? "yt-dlp"
      const commonArgs = ["--no-config", "--no-playlist", "--format", "bestaudio/best"]
      // Emit only the duration field as JSON, not the full upstream metadata object.
      // Metadata and download share one deadline and the caller's cancellation scope.
      const metadata = await run(
        ytdlp,
        [...commonArgs, "--skip-download", "--print", "%(.{duration})j", url],
        downloadSignal,
        "yt-dlp",
      )
      if (Buffer.byteLength(metadata.stdout) > MAX_COMMAND_OUTPUT_BYTES) {
        throw new FailureDiagnosticError("YtdlpLoader", url, {
          code: "metadata_failed",
          phase,
        })
      }
      const parsed: unknown = JSON.parse(metadata.stdout)
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new FailureDiagnosticError("YtdlpLoader", url, {
          code: "metadata_failed",
          phase,
        })
      }
      const duration = "duration" in parsed ? parsed.duration : undefined
      if (
        typeof duration === "number" &&
        Number.isFinite(duration) &&
        duration <= Number.MAX_SAFE_INTEGER &&
        duration >= 0 &&
        duration > maxDurationSeconds
      ) {
        throw new FailureDiagnosticError("YtdlpLoader", url, {
          code: "media_duration_limit",
          phase,
          limit: maxDurationSeconds,
          observed: duration,
        })
      }

      phase = "download"
      await run(
        ytdlp,
        [
          ...commonArgs,
          "--extract-audio",
          "--audio-format",
          "mp3",
          "--audio-quality",
          "192K",
          "--max-filesize",
          String(maxMediaBytes),
          "--match-filter",
          `duration <= ${maxDurationSeconds}`,
          "--output",
          join(directory, "audio.%(ext)s"),
          url,
        ],
        downloadSignal,
        "yt-dlp",
      )
      const size = (await stat(audioPath)).size
      downloadSignal.throwIfAborted()
      if (size > maxMediaBytes) {
        throw new FailureDiagnosticError("YtdlpLoader", url, {
          code: "media_size_limit",
          phase,
          limit: maxMediaBytes,
          observed: size,
        })
      }

      phase = "transcription"
      transcriptionTimeout = AbortSignal.timeout(transcriptionTimeoutMs)
      const transcriptionSignal = signal
        ? AbortSignal.any([signal, transcriptionTimeout])
        : transcriptionTimeout
      await run(
        this.options.whisperPath ?? "whisper",
        [
          audioPath,
          "--model",
          this.options.model ?? "tiny",
          "--output_dir",
          directory,
          "--output_format",
          "txt",
        ],
        transcriptionSignal,
        "whisper",
      )
      const content = (await readFile(join(directory, "audio.txt"), "utf8")).trim()
      transcriptionSignal.throwIfAborted()
      if (!content) {
        throw new FailureDiagnosticError("YtdlpLoader", url, { code: "empty_content", phase })
      }
      return content
    } catch (error) {
      if (signal?.aborted) throw signal.reason
      if (phase === "transcription" ? transcriptionTimeout?.aborted : downloadTimeout.aborted) {
        throw new LoaderTimeoutError(
          "YtdlpLoader",
          url,
          (phase === "transcription" ? transcriptionTimeoutMs : downloadTimeoutMs) / 1_000,
          "The media operation timed out.",
          {
            code: phase === "transcription" ? "transcription_timeout" : "download_timeout",
            phase,
          },
        )
      }
      if (error instanceof MissingDependencyError || error instanceof FailureDiagnosticError) {
        throw error
      }
      throw new FailureDiagnosticError("YtdlpLoader", url, {
        code:
          phase === "metadata"
            ? "metadata_failed"
            : phase === "download"
              ? "download_failed"
              : "transcription_failed",
        phase,
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}

export class YouTubeYtdlpLoader implements Loader {
  constructor(private readonly loader: Loader = new YtdlpLoader()) {}

  async load(url: string, signal?: AbortSignal): Promise<string> {
    const { videoId } = requireLoaderApplicability(
      "YouTubeYtdlpLoader",
      url,
      parseYouTubeVideoTarget,
    )
    if (!/^[A-Za-z0-9_-]{11}$/u.test(videoId)) {
      throw new LoaderContentError("YouTubeYtdlpLoader", url, "Invalid video ID")
    }
    // Do not forward arbitrary query parameters or third-party YouTube-compatible hosts to yt-dlp.
    return this.loader.load(`https://www.youtube.com/watch?v=${videoId}`, signal)
  }
}

export { YouTubeYtdlpLoader as YoutubeYtdlpLoader }
