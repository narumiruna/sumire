import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import {
  FailureDiagnosticError,
  LoaderContentError,
  LoaderTimeoutError,
  MissingDependencyError,
} from "../src/core/errors.js"
import {
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
  const outputIndex = args.indexOf("--output")
  const output = args[outputIndex + 1]
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

function fixtureRunner(metadata = '{"duration":30}', transcript = "transcript") {
  return vi.fn(async (_command: string, args: readonly string[], _signal?: AbortSignal) => {
    if (args.includes("--skip-download")) return { stdout: metadata, stderr: "" }
    if (args.includes("--output")) {
      await writeFile(join(captureOutputDirectory(args), "audio.mp3"), "audio")
    } else {
      const directory = args[args.indexOf("--output_dir") + 1]
      if (!directory) throw new Error("missing transcription output directory")
      await writeFile(join(directory, "audio.txt"), transcript)
    }
    return { stdout: "", stderr: "" }
  })
}

describe("yt-dlp loader limits", () => {
  it("rejects a duration confirmed by structured metadata before downloading", async () => {
    const runner = fixtureRunner('{"duration":5198}')
    const allocation = vi.mocked(mkdtemp).mock.results.length
    await expect(
      new YtdlpLoader({ commandRunner: runner }).load("https://example.com/video"),
    ).rejects.toMatchObject({
      diagnostic: { code: "media_duration_limit", phase: "metadata", limit: 3600, observed: 5198 },
    })
    expect(runner).toHaveBeenCalledOnce()
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
      new YtdlpLoader({ commandRunner: runner }).load("https://example.com/video"),
    ).resolves.toBe("transcript")
    expect(runner).toHaveBeenCalledTimes(3)
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
      new YtdlpLoader({ commandRunner: runner }).load("https://example.com/video"),
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
      new YtdlpLoader({ commandRunner: runner }).load("https://example.com/video"),
    ).rejects.toMatchObject({ diagnostic: { code: "download_failed", phase: "download" } })
    expect(runner).toHaveBeenCalledTimes(2)
    await expectRemoved(directory)
  })

  it.each(["metadata", "download", "transcription"] as const)(
    "reports a safe %s failure without command output",
    async (phase) => {
      const runner = fixtureRunner()
      const implementation = runner.getMockImplementation()
      if (!implementation) throw new Error("missing fixture implementation")
      runner.mockImplementation(async (command, args, signal) => {
        const currentPhase = args.includes("--skip-download")
          ? "metadata"
          : args.includes("--output")
            ? "download"
            : "transcription"
        if (currentPhase === phase)
          throw new Error(
            "secret stderr: https://user:password@example.com/?token=private; duration > 3600",
          )
        return implementation(command, args, signal)
      })
      const error = await new YtdlpLoader({ commandRunner: runner })
        .load("https://example.com/video")
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(FailureDiagnosticError)
      expect(error).toMatchObject({ diagnostic: { code: `${phase}_failed`, phase } })
      expect(String(error)).not.toMatch(/secret|password|token|3600/u)
    },
  )

  it.each(["yt-dlp", "whisper"] as const)(
    "identifies a missing %s executable from ENOENT only",
    async (dependency) => {
      const runner = fixtureRunner()
      const implementation = runner.getMockImplementation()
      if (!implementation) throw new Error("missing fixture implementation")
      runner.mockImplementation(async (command, args, signal) => {
        if (command === dependency)
          throw Object.assign(new Error("secret local path"), { code: "ENOENT" })
        return implementation(command, args, signal)
      })
      const error = await new YtdlpLoader({ commandRunner: runner })
        .load("https://example.com/video")
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(MissingDependencyError)
      expect(error).toMatchObject({
        diagnostic: {
          code: "dependency_missing",
          dependency,
          phase: dependency === "yt-dlp" ? "metadata" : "transcription",
        },
      })
      expect(String(error)).not.toContain("secret local path")
    },
  )

  it.each(["metadata", "download", "transcription"] as const)(
    "attributes the timeout to %s without resetting the download budget",
    async (phase) => {
      const runner = fixtureRunner()
      const implementation = runner.getMockImplementation()
      if (!implementation) throw new Error("missing fixture implementation")
      runner.mockImplementation(async (command, args, signal) => {
        const currentPhase = args.includes("--skip-download")
          ? "metadata"
          : args.includes("--output")
            ? "download"
            : "transcription"
        if (currentPhase !== phase) return implementation(command, args, signal)
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
        return { stdout: "", stderr: "" }
      })
      const error = await new YtdlpLoader({
        commandRunner: runner,
        downloadTimeoutMs: 30,
        transcriptionTimeoutMs: 30,
      })
        .load("https://example.com/video")
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(LoaderTimeoutError)
      expect(error).toMatchObject({
        diagnostic: {
          code: phase === "transcription" ? "transcription_timeout" : "download_timeout",
          phase,
        },
      })
      if (phase !== "metadata") expect(runner.mock.calls[0]?.[2]).toBe(runner.mock.calls[1]?.[2])
    },
  )

  it.each(["metadata", "transcription"] as const)(
    "preserves caller cancellation during %s and removes temporary files",
    async (phase) => {
      const allocation = vi.mocked(mkdtemp).mock.results.length
      const controller = new AbortController()
      const reason = new Error("caller cancelled with private details")
      const runner = fixtureRunner()
      const implementation = runner.getMockImplementation()
      if (!implementation) throw new Error("missing fixture implementation")
      let commandStarted: (() => void) | undefined
      const started = new Promise<void>((resolve) => {
        commandStarted = resolve
      })
      runner.mockImplementation(async (command, args, signal) => {
        const isRequestedPhase =
          phase === "metadata" ? args.includes("--skip-download") : args.includes("--output_dir")
        if (!isRequestedPhase) return implementation(command, args, signal)
        commandStarted?.()
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      })
      const loading = new YtdlpLoader({ commandRunner: runner }).load(
        "https://example.com/video",
        controller.signal,
      )
      await started
      controller.abort(reason)
      await expect(loading).rejects.toBe(reason)
      await expectRemoved(await vi.mocked(mkdtemp).mock.results[allocation]?.value)
    },
  )

  it("allows duration equal to the configured limit", async () => {
    await expect(
      new YtdlpLoader({ commandRunner: fixtureRunner('{"duration":3600}') }).load(
        "https://example.com/video",
      ),
    ).resolves.toBe("transcript")
  })

  it("rejects empty transcription output", async () => {
    const runner = fixtureRunner('{"duration":30}', "  ")
    await expect(
      new YtdlpLoader({ commandRunner: runner }).load("https://example.com/video"),
    ).rejects.toMatchObject({ diagnostic: { code: "empty_content", phase: "transcription" } })
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

  it("terminates subprocesses when their signal expires", async () => {
    const timeout = AbortSignal.timeout(10)
    await expect(
      runCommand(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], timeout),
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
        if (processGroupId && processGroupExists(processGroupId)) {
          process.kill(-processGroupId, "SIGKILL")
        }
        await rm(directory, { recursive: true, force: true })
      }
    },
  )

  it("rejects oversized audio before starting Whisper", async () => {
    const commands: Array<{ command: string; args: readonly string[] }> = []
    const whisper = vi.fn(async () => ({ stdout: "", stderr: "" }))
    let directory: string | undefined
    const loader = new YtdlpLoader({
      ytdlpPath: "fake-ytdlp",
      whisperPath: "fake-whisper",
      maxMediaBytes: 3,
      maxDurationSeconds: 60,
      commandRunner: async (command, args) => {
        commands.push({ command, args })
        if (args.includes("--skip-download")) return { stdout: '{"duration":30}', stderr: "" }
        if (command === "fake-whisper") return whisper()
        directory = captureOutputDirectory(args)
        const outputIndex = args.indexOf("--output")
        const output = args[outputIndex + 1]?.replace("%(ext)s", "mp3")
        if (!output) throw new Error("missing output path")
        await writeFile(output, "four")
        return { stdout: "", stderr: "" }
      },
    })

    await expect(loader.load("https://example.com/video")).rejects.toMatchObject({
      diagnostic: { code: "media_size_limit", phase: "download", limit: 3, observed: 4 },
    })
    expect(commands[1]?.args).toEqual(
      expect.arrayContaining(["--max-filesize", "3", "--match-filter", "duration <= 60"]),
    )
    expect(whisper).not.toHaveBeenCalled()
    await expectRemoved(directory)
  })

  it("removes temporary media after successful transcription", async () => {
    let directory: string | undefined
    const loader = new YtdlpLoader({
      ytdlpPath: "fake-ytdlp",
      whisperPath: "fake-whisper",
      commandRunner: async (command, args) => {
        if (args.includes("--skip-download")) return { stdout: '{"duration":30}', stderr: "" }
        if (command === "fake-ytdlp") {
          directory = captureOutputDirectory(args)
          await writeFile(join(directory, "audio.mp3"), "audio")
        } else {
          const outputDirectory = args[args.indexOf("--output_dir") + 1]
          if (!outputDirectory) throw new Error("missing Whisper output directory")
          await writeFile(join(outputDirectory, "audio.txt"), " transcript ")
        }
        return { stdout: "", stderr: "" }
      },
    })

    await expect(loader.load("https://example.com/video")).resolves.toBe("transcript")
    await expectRemoved(directory)
  })

  it("removes temporary media after command failure", async () => {
    let directory: string | undefined
    const loader = new YtdlpLoader({
      ytdlpPath: "fake-ytdlp",
      commandRunner: async (_command, args) => {
        if (args.includes("--skip-download")) return { stdout: '{"duration":30}', stderr: "" }
        directory = captureOutputDirectory(args)
        throw new Error("download failed")
      },
    })

    await expect(loader.load("https://example.com/video")).rejects.toBeInstanceOf(
      LoaderContentError,
    )
    await expectRemoved(directory)
  })

  it("removes temporary media after download timeout", async () => {
    let directory: string | undefined
    const loader = new YtdlpLoader({
      ytdlpPath: "fake-ytdlp",
      downloadTimeoutMs: 5,
      commandRunner: async (_command, args, signal) => {
        if (args.includes("--skip-download")) return { stdout: '{"duration":30}', stderr: "" }
        directory = captureOutputDirectory(args)
        signal?.throwIfAborted()
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
        return { stdout: "", stderr: "" }
      },
    })

    await expect(loader.load("https://example.com/video")).rejects.toBeInstanceOf(
      LoaderTimeoutError,
    )
    await expectRemoved(directory)
  })

  it("removes temporary media after caller cancellation", async () => {
    let directory: string | undefined
    let commandStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      commandStarted = resolve
    })
    const loader = new YtdlpLoader({
      ytdlpPath: "fake-ytdlp",
      commandRunner: async (_command, args, signal) => {
        if (args.includes("--skip-download")) return { stdout: '{"duration":30}', stderr: "" }
        directory = captureOutputDirectory(args)
        signal?.throwIfAborted()
        commandStarted?.()
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
        return { stdout: "", stderr: "" }
      },
    })
    const controller = new AbortController()
    const reason = new Error("cancelled")
    const loading = loader.load("https://example.com/video", controller.signal)
    await started
    controller.abort(reason)

    await expect(loading).rejects.toBe(reason)
    await expectRemoved(directory)
  })
})
