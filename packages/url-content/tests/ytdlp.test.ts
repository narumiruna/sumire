import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { LoaderContentError, LoaderTimeoutError } from "../src/core/errors.js"
import { runCommand, YtdlpLoader } from "../src/loaders/ytdlp.js"

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

describe("yt-dlp loader limits", () => {
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
        if (command === "fake-whisper") return whisper()
        directory = captureOutputDirectory(args)
        const outputIndex = args.indexOf("--output")
        const output = args[outputIndex + 1]?.replace("%(ext)s", "mp3")
        if (!output) throw new Error("missing output path")
        await writeFile(output, "four")
        return { stdout: "", stderr: "" }
      },
    })

    await expect(loader.load("https://example.com/video")).rejects.toThrow("3 byte limit")
    expect(commands[0]?.args).toEqual(
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
