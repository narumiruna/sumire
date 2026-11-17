import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import {
  AudioTranscriptionError,
  closeAudioTranscriber,
  type TranscribeAudioFile,
  withAudioTranscriber,
} from "../src/audio.js"
import {
  FailureDiagnosticError,
  LoaderContentError,
  LoaderTimeoutError,
  MissingDependencyError,
} from "../src/core/errors.js"
import { createAttemptExecution } from "../src/core/execution.js"
import {
  DEFAULT_WHISPER_TIMEOUT_MS,
  MAX_COMMAND_OUTPUT_BYTES,
  runCommand,
  YouTubeYtdlpLoader,
  YtdlpLoader,
} from "../src/loaders/ytdlp.js"

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>()
  return { ...original, mkdtemp: vi.fn(original.mkdtemp) }
})

function captureOutputDirectory(args: readonly string[]): string {
  const output = args[args.indexOf("--output") + 1]
  if (!output) throw new Error("missing output path")
  return dirname(output)
}

async function expectRemoved(directory: string | undefined): Promise<void> {
  expect(directory).toBeDefined()
  await expect(access(directory as string)).rejects.toMatchObject({ code: "ENOENT" })
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0)
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
    throw error
  }
}

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function waitForAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal?.throwIfAborted()
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
  })
}

function fixtureRunner(metadata = '{"duration":30}') {
  return vi.fn(async (_command: string, args: readonly string[], _signal?: AbortSignal) => {
    if (args.includes("--skip-download")) return { stdout: metadata, stderr: "" }
    await writeFile(join(captureOutputDirectory(args), "audio.mp3"), "audio")
    return { stdout: "", stderr: "" }
  })
}

function fixtureLoader(options: ConstructorParameters<typeof YtdlpLoader>[0] = {}) {
  return new YtdlpLoader({ transcribe: async () => "transcript", ...options })
}

const stages = [
  "metadata",
  "download",
  "transcription",
  "decode",
  "model_load",
  "inference",
] as const

function stageFixture(
  stage: (typeof stages)[number],
  operation: (signal?: AbortSignal) => Promise<never>,
) {
  const runner = fixtureRunner()
  const implementation = runner.getMockImplementation()
  if (!implementation) throw new Error("missing fixture implementation")
  runner.mockImplementation(async (command, args, signal) => {
    const phase = args.includes("--skip-download") ? "metadata" : "download"
    if (phase === stage) return operation(signal)
    return implementation(command, args, signal)
  })
  const transcribe: TranscribeAudioFile = async (_path, options) => {
    if (stage !== "metadata" && stage !== "download" && stage !== "transcription")
      options.onPhase?.(stage)
    return operation(options.signal)
  }
  return { commandRunner: runner, transcribe }
}

describe("yt-dlp loader limits", () => {
  it("retains the public transcription timeout constant", () => {
    expect(DEFAULT_WHISPER_TIMEOUT_MS).toBe(3_000_000)
  })

  it("uses five-minute download and fifty-minute transcription budgets by default", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout")
    try {
      await expect(
        fixtureLoader({ commandRunner: fixtureRunner() }).load("https://example.com/video"),
      ).resolves.toBe("transcript")
      expect(timeout.mock.calls).toEqual([[300_000], [3_000_000]])
    } finally {
      timeout.mockRestore()
    }
  })

  it("rejects a duration confirmed by structured metadata before downloading", async () => {
    const runner = fixtureRunner('{"duration":5198}')
    const transcribe = vi.fn(async () => "transcript")
    const allocation = vi.mocked(mkdtemp).mock.results.length
    await expect(
      fixtureLoader({ commandRunner: runner, transcribe }).load("https://example.com/video"),
    ).rejects.toMatchObject({
      diagnostic: { code: "media_duration_limit", phase: "metadata", limit: 3600, observed: 5198 },
    })
    expect(runner).toHaveBeenCalledOnce()
    expect(transcribe).not.toHaveBeenCalled()
    expect(runner.mock.calls[0]?.[1]).toEqual([
      "--no-config",
      "--no-playlist",
      "--format",
      "bestaudio/best",
      "--skip-download",
      "--print",
      "%(.{duration})j",
      "https://example.com/video",
    ])
    await expectRemoved(await vi.mocked(mkdtemp).mock.results[allocation]?.value)
  })

  it.each([
    "{}",
    '{"duration":null}',
    '{"duration":"5198"}',
    '{"duration":-1}',
    '{"duration":1e400}',
    '{"duration":1e20}',
  ])("does not infer a duration limit from unknown duration %s", async (metadata) => {
    const runner = fixtureRunner(metadata)
    await expect(
      fixtureLoader({ commandRunner: runner }).load("https://example.com/video"),
    ).resolves.toBe("transcript")
    expect(runner).toHaveBeenCalledTimes(2)
    expect(runner.mock.calls[0]?.[2]).toBe(runner.mock.calls[1]?.[2])
  })

  it.each([
    "not json",
    "[]",
    "null",
    '"hostile upstream text"',
    "x".repeat(MAX_COMMAND_OUTPUT_BYTES + 1),
  ])("rejects malformed or excessive metadata (fixture %#)", async (metadata) => {
    const runner = fixtureRunner(metadata)
    const allocation = vi.mocked(mkdtemp).mock.results.length
    await expect(
      fixtureLoader({ commandRunner: runner }).load("https://example.com/video"),
    ).rejects.toMatchObject({ diagnostic: { code: "metadata_failed", phase: "metadata" } })
    expect(runner).toHaveBeenCalledOnce()
    await expectRemoved(await vi.mocked(mkdtemp).mock.results[allocation]?.value)
  })

  it("does not infer a limit or missing dependency when a filtered download leaves no file", async () => {
    let directory: string | undefined
    const runner = fixtureRunner("{}")
    runner
      .mockImplementationOnce(async () => ({ stdout: "{}", stderr: "" }))
      .mockImplementationOnce(async (_command, args) => {
        directory = captureOutputDirectory(args)
        return { stdout: "", stderr: "duration > 3600; max-filesize; ffmpeg missing" }
      })
    await expect(
      fixtureLoader({ commandRunner: runner }).load("https://example.com/video"),
    ).rejects.toMatchObject({ diagnostic: { code: "download_failed", phase: "download" } })
    expect(runner).toHaveBeenCalledTimes(2)
    await expectRemoved(directory)
  })

  it.each(stages)("reports a safe %s failure without backend output", async (phase) => {
    const options = stageFixture(phase, async () => {
      throw new Error(
        "secret stderr: https://user:password@example.com/?token=private; duration > 3600",
      )
    })
    const error = await fixtureLoader(options)
      .load("https://example.com/video")
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(FailureDiagnosticError)
    expect(error).toMatchObject({
      diagnostic: {
        code:
          phase === "metadata" || phase === "download" ? `${phase}_failed` : "transcription_failed",
        phase,
      },
    })
    expect(String(error)).not.toMatch(/secret|password|token|3600/u)
  })

  it("identifies missing yt-dlp only from ENOENT", async () => {
    const runner = vi.fn(async () => {
      throw Object.assign(new Error("secret local path"), { code: "ENOENT" })
    })
    const error = await fixtureLoader({ commandRunner: runner })
      .load("https://example.com/video")
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(MissingDependencyError)
    expect(error).toMatchObject({
      diagnostic: { code: "dependency_missing", dependency: "yt-dlp", phase: "metadata" },
    })
    expect(String(error)).not.toContain("secret local path")
  })

  it.each([
    new AudioTranscriptionError("dependency_missing", "decode", "ffmpeg"),
    new AudioTranscriptionError("dependency_missing", "model_load", "@huggingface/transformers"),
    new AudioTranscriptionError("media_duration_limit", "decode", undefined, 60, 61),
    new AudioTranscriptionError("transcription_failed", "model_load"),
    new AudioTranscriptionError("transcription_failed", "inference"),
    new AudioTranscriptionError("empty_content", "inference"),
  ])("maps structured audio errors without raw text (fixture %#)", async (failure) => {
    failure.message =
      "secret stderr, /private/audio.mp3, https://user:password@example.com/?token=private"
    const transcribe: TranscribeAudioFile = async () => {
      throw failure
    }
    const error = await fixtureLoader({ commandRunner: fixtureRunner(), transcribe })
      .load("https://example.com/video")
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      diagnostic: {
        code: failure.kind,
        phase: failure.phase,
        ...(failure.dependency ? { dependency: failure.dependency } : {}),
        ...(failure.limit !== undefined
          ? { limit: failure.limit, observed: failure.observed }
          : {}),
      },
    })
    expect(String(error)).not.toMatch(/secret|private|password|token/u)
  })

  it.each(stages)("attributes the timeout to %s", async (phase) => {
    const options = stageFixture(phase, waitForAbort)
    const allocation = vi.mocked(mkdtemp).mock.results.length
    const error = await fixtureLoader({
      ...options,
      downloadTimeoutMs: 50,
      transcriptionTimeoutMs: 50,
    })
      .load("https://example.com/video")
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(LoaderTimeoutError)
    expect(error).toMatchObject({
      diagnostic: {
        code:
          phase === "metadata" || phase === "download"
            ? "download_timeout"
            : "transcription_timeout",
        phase,
      },
    })
    if (phase !== "metadata")
      expect(options.commandRunner.mock.calls[0]?.[2]).toBe(
        options.commandRunner.mock.calls[1]?.[2],
      )
    await expectRemoved(await vi.mocked(mkdtemp).mock.results[allocation]?.value)
  })

  it.each(stages)("preserves caller abort identity and the active %s stage", async (phase) => {
    const started = deferred()
    const controller = new AbortController()
    const reason = new Error("caller cancelled with private details")
    const allocation = vi.mocked(mkdtemp).mock.results.length
    const options = stageFixture(phase, (signal) => {
      started.resolve()
      return waitForAbort(signal)
    })
    const execution = createAttemptExecution()
    const loading = execution.run(() =>
      fixtureLoader(options).load("https://example.com/video", controller.signal),
    )
    await started.promise
    expect(execution.finish().phase).toBe(phase)
    controller.abort(reason)
    await expect(loading).rejects.toBe(reason)
    await expectRemoved(await vi.mocked(mkdtemp).mock.results[allocation]?.value)
  })

  it("gives caller cancellation precedence over a transcription timeout", async () => {
    const controller = new AbortController()
    const reason = new Error("caller abort")
    const transcribe: TranscribeAudioFile = async (_path, { signal }) => {
      try {
        return await waitForAbort(signal)
      } finally {
        controller.abort(reason)
      }
    }
    await expect(
      fixtureLoader({
        commandRunner: fixtureRunner(),
        transcribe,
        transcriptionTimeoutMs: 10,
      }).load("https://example.com/video", controller.signal),
    ).rejects.toBe(reason)
  })

  it("does not reset the transcription budget at stage changes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
      const controller = new AbortController()
      setTimeout(
        () => controller.abort(new DOMException("Timed out", "TimeoutError")),
        milliseconds,
      )
      return controller.signal
    })
    try {
      const started = deferred()
      let signal: AbortSignal | undefined
      let phase = ""
      const transcribe: TranscribeAudioFile = async (_path, options) => {
        signal = options.signal
        phase = "decode"
        options.onPhase?.("decode")
        started.resolve()
        await new Promise((resolve) => setTimeout(resolve, 30))
        options.signal?.throwIfAborted()
        phase = "model_load"
        options.onPhase?.("model_load")
        return waitForAbort(options.signal)
      }
      const loading = fixtureLoader({
        commandRunner: fixtureRunner(),
        transcribe,
        transcriptionTimeoutMs: 60,
      })
        .load("https://example.com/video")
        .catch((error: unknown) => error)
      await started.promise
      const originalDeadline = performance.now() + 60
      await vi.advanceTimersByTimeAsync(30)
      expect(phase).toBe("model_load")
      await vi.advanceTimersByTimeAsync(29)
      expect(signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(performance.now()).toBe(originalDeadline)
      expect(signal?.aborted).toBe(true)
      expect(await loading).toMatchObject({
        diagnostic: { code: "transcription_timeout", phase: "model_load" },
      })
    } finally {
      timeout.mockRestore()
      vi.useRealTimers()
    }
  })

  it("allows duration equal to the configured limit and passes the tiny model alias", async () => {
    const transcribe = vi.fn<TranscribeAudioFile>(async () => " transcript ")
    await expect(
      fixtureLoader({ commandRunner: fixtureRunner('{"duration":3600}'), transcribe }).load(
        "https://example.com/video",
      ),
    ).resolves.toBe("transcript")
    expect(transcribe).toHaveBeenCalledWith(
      expect.stringMatching(/audio\.mp3$/u),
      expect.objectContaining({
        model: "tiny",
        maxDurationSeconds: 3600,
        signal: expect.any(AbortSignal),
        onPhase: expect.any(Function),
      }),
    )
  })

  it("passes a full model ID to the backend unchanged", async () => {
    const transcribe = vi.fn<TranscribeAudioFile>(async () => "transcript")
    await fixtureLoader({
      commandRunner: fixtureRunner(),
      transcribe,
      model: "example/whisper-small",
    }).load("https://example.com/video")
    expect(transcribe.mock.calls[0]?.[1].model).toBe("example/whisper-small")
  })

  it("rejects empty transcription output", async () => {
    await expect(
      fixtureLoader({ commandRunner: fixtureRunner(), transcribe: async () => "  " }).load(
        "https://example.com/video",
      ),
    ).rejects.toMatchObject({ diagnostic: { code: "empty_content", phase: "transcription" } })
  })

  it("acquires shared admission before metadata or temporary file allocation", async () => {
    const entered = deferred()
    const release = deferred()
    const occupying = withAudioTranscriber(async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const allocation = vi.mocked(mkdtemp).mock.results.length
    const runner = fixtureRunner()
    const controller = new AbortController()
    const reason = new Error("queued cancellation")
    const loading = fixtureLoader({ commandRunner: runner }).load(
      "https://example.com/video",
      controller.signal,
    )
    expect(runner).not.toHaveBeenCalled()
    expect(vi.mocked(mkdtemp).mock.results.length).toBe(allocation)
    controller.abort(reason)
    try {
      await expect(loading).rejects.toBe(reason)
    } finally {
      release.resolve()
      await occupying
    }
    expect(runner).not.toHaveBeenCalled()
  })

  it("removes temporary media before releasing shared admission", async () => {
    const entered = deferred()
    const release = deferred()
    let firstPath: string | undefined
    const transcribe: TranscribeAudioFile = async (path) => {
      firstPath = path
      entered.resolve()
      await release.promise
      return "first"
    }
    const first = fixtureLoader({ commandRunner: fixtureRunner(), transcribe }).load(
      "https://example.com/first",
    )
    await entered.promise
    const runner = fixtureRunner()
    const implementation = runner.getMockImplementation()
    if (!implementation) throw new Error("missing fixture implementation")
    runner.mockImplementation(async (...args) => {
      await expectRemoved(firstPath)
      return implementation(...args)
    })
    const second = fixtureLoader({ commandRunner: runner }).load("https://example.com/second")
    expect(runner).not.toHaveBeenCalled()
    release.resolve()
    await expect(first).resolves.toBe("first")
    await expect(second).resolves.toBe("transcript")
  })

  it("rejects oversized audio before starting ASR", async () => {
    const runner = fixtureRunner()
    const transcribe = vi.fn(async () => "transcript")
    const allocation = vi.mocked(mkdtemp).mock.results.length
    await expect(
      fixtureLoader({
        ytdlpPath: "fake-ytdlp",
        commandRunner: runner,
        transcribe,
        maxMediaBytes: 3,
        maxDurationSeconds: 60,
      }).load("https://example.com/video"),
    ).rejects.toMatchObject({
      diagnostic: { code: "media_size_limit", phase: "download", limit: 3, observed: 5 },
    })
    expect(runner.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(["--max-filesize", "3", "--match-filter", "duration <= 60"]),
    )
    expect(transcribe).not.toHaveBeenCalled()
    await expectRemoved(await vi.mocked(mkdtemp).mock.results[allocation]?.value)
  })

  it("removes temporary media after command failure", async () => {
    const allocation = vi.mocked(mkdtemp).mock.results.length
    const runner = fixtureRunner()
    runner.mockRejectedValueOnce(new Error("metadata failed"))
    await expect(
      fixtureLoader({ commandRunner: runner }).load("https://example.com/video"),
    ).rejects.toBeInstanceOf(LoaderContentError)
    await expectRemoved(await vi.mocked(mkdtemp).mock.results[allocation]?.value)
  })

  it("passes only a validated canonical video URL to yt-dlp", async () => {
    const load = vi.fn(async () => "transcript")
    const loader = new YouTubeYtdlpLoader({ load })
    await expect(
      loader.load("https://vid.plus/watch?v=dQw4w9WgXcQ&next=http://127.0.0.1/"),
    ).resolves.toBe("transcript")
    expect(load).toHaveBeenCalledWith("https://www.youtube.com/watch?v=dQw4w9WgXcQ", undefined)
    await expect(loader.load("https://youtube.com/watch?v=dQw4w9WgX%3C")).rejects.toThrow()
    expect(load).toHaveBeenCalledOnce()
  })

  it("shutdown aborts yt-dlp preparation without waiting for its local timer", async () => {
    let active: AbortSignal | undefined
    const commandRunner = vi.fn(
      async (_command: string, _args: readonly string[], signal?: AbortSignal) => {
        active = signal
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
        return { stdout: "", stderr: "" }
      },
    )
    const loader = new YtdlpLoader({ commandRunner, downloadTimeoutMs: 60_000 })
    const work = loader.load("https://example.com/video")
    const failure = expect(work).rejects.toBeInstanceOf(AudioTranscriptionError)
    await vi.waitFor(() => expect(commandRunner).toHaveBeenCalledOnce())
    await closeAudioTranscriber()
    await failure
    expect(active?.aborted).toBe(true)
    expect(commandRunner).toHaveBeenCalledOnce()
  })

  it("caps combined stdout and stderr and terminates the command", async () => {
    await expect(
      runCommand(process.execPath, [
        "-e",
        `process.stdout.write('a'.repeat(${MAX_COMMAND_OUTPUT_BYTES})); process.stderr.write('b'.repeat(100)); setInterval(() => {}, 1000)`,
      ]),
    ).rejects.toThrow("Command output limit exceeded")
  })

  it("does not expose stderr, executable paths, or command arguments on process failure", async () => {
    const error = await runCommand(process.execPath, [
      "-e",
      "console.error('private token'); process.exit(1)",
    ]).catch((caught: unknown) => caught)
    expect(String(error)).toBe("Error: External command failed")
  })

  it("terminates subprocesses when their signal expires", async () => {
    await expect(
      runCommand(
        process.execPath,
        ["-e", "setInterval(() => undefined, 1000)"],
        AbortSignal.timeout(10),
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" })
  })

  it.skipIf(process.platform === "win32")(
    "terminates a subprocess tree whose descendant ignores SIGTERM",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "sumire-ytdlp-tree-"))
      const readyPath = join(directory, "grandchild-ready")
      const childScript = [
        'const fs = require("node:fs")',
        'process.on("SIGTERM", () => undefined)',
        `fs.writeFileSync(${JSON.stringify(readyPath)}, String(process.ppid))`,
        "setInterval(() => undefined, 1000)",
      ].join(";")
      const parentScript = [
        'const { spawn } = require("node:child_process")',
        `spawn(process.execPath, ["-e", ${JSON.stringify(childScript)}], { stdio: "ignore" })`,
        "setInterval(() => undefined, 1000)",
      ].join(";")
      const controller = new AbortController()
      const cancelled = new Error("cancelled")
      const running = runCommand(process.execPath, ["-e", parentScript], controller.signal)
      let processGroupId: number | undefined
      try {
        await vi.waitFor(async () => {
          processGroupId = Number(await readFile(readyPath, "utf8"))
          expect(processGroupId).toBeGreaterThan(0)
        })
        controller.abort(cancelled)
        await expect(running).rejects.toBe(cancelled)
        await vi.waitFor(() => expect(processGroupExists(processGroupId as number)).toBe(false))
      } finally {
        if (processGroupId && processGroupExists(processGroupId))
          process.kill(-processGroupId, "SIGKILL")
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
})
