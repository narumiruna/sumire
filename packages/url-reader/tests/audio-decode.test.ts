import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { decodeAudioFile } from "../src/audio/decode.js"

vi.mock("node:child_process", () => ({ spawn: vi.fn() }))

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sumire-decode-test-"))
})
afterEach(async () => {
  vi.useRealTimers()
  vi.resetAllMocks()
  await rm(directory, { recursive: true, force: true })
})

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  })
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
  return child
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

describe("bounded FFmpeg decoding", () => {
  it("does not spawn when already cancelled", async () => {
    const reason = new Error("abort")
    await expect(
      decodeAudioFile("/input", join(directory, "pcm"), 1, AbortSignal.abort(reason)),
    ).rejects.toBe(reason)
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each([0, -1, NaN, Infinity])("rejects invalid duration %s without spawning", async (limit) => {
    await expect(
      decodeAudioFile("/input", join(directory, "pcm"), limit, new AbortController().signal),
    ).rejects.toMatchObject({ kind: "transcription_failed", phase: "decode" })
    expect(spawn).not.toHaveBeenCalled()
  })

  it("uses local-only, fixed mono 16kHz float32 arguments without a shell", async () => {
    const child = fakeChild()
    const pending = decodeAudioFile(
      "/input",
      join(directory, "pcm"),
      1,
      new AbortController().signal,
    )
    child.stdout.end(Buffer.alloc(64))
    child.emit("close", 0)
    await expect(pending).resolves.toBe(16)
    const [command, args, options] = vi.mocked(spawn).mock.calls[0] ?? []
    expect(command).toBe("ffmpeg")
    expect(args).toEqual(
      expect.arrayContaining([
        "-nostdin",
        "-protocol_whitelist",
        "file,pipe",
        "-ac",
        "1",
        "-ar",
        "16000",
        "pcm_f32le",
      ]),
    )
    expect(options).toMatchObject({ stdio: ["ignore", "pipe", "ignore"] })
    expect(options).not.toHaveProperty("shell")
  })

  it("recognizes a missing FFmpeg only from spawn ENOENT", async () => {
    const child = fakeChild()
    const pending = decodeAudioFile(
      "/input",
      join(directory, "pcm"),
      1,
      new AbortController().signal,
    )
    child.emit("error", Object.assign(new Error("private native path"), { code: "ENOENT" }))
    child.stdout.end()
    child.emit("close", -2)
    await expect(pending).rejects.toMatchObject({
      kind: "dependency_missing",
      phase: "decode",
      dependency: "ffmpeg",
      message: "An audio transcription dependency is unavailable",
    })
  })

  it("escalates abort to SIGKILL but does not settle until process closure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    const child = fakeChild()
    const controller = new AbortController()
    const reason = new Error("cancelled")
    let settled = false
    const pending = decodeAudioFile("/input", join(directory, "pcm"), 1, controller.signal)
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true
      })
    controller.abort(reason)
    child.stdout.end()
    await turn()
    expect(child.kill).toHaveBeenCalledWith("SIGTERM")
    await vi.advanceTimersByTimeAsync(200)
    expect(child.kill).toHaveBeenCalledWith("SIGKILL")
    expect(settled).toBe(false)
    child.emit("close", null, "SIGKILL")
    expect(await pending).toBe(reason)
  })

  it("guards bytes during streaming and awaits closure before returning an overflow", async () => {
    const child = fakeChild()
    let settled = false
    const pending = decodeAudioFile(
      "/input",
      join(directory, "pcm"),
      0.001,
      new AbortController().signal,
    )
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true
      })
    child.stdout.write(Buffer.alloc(65))
    await turn()
    expect(child.kill).toHaveBeenCalledWith("SIGTERM")
    expect(settled).toBe(false)
    child.emit("close", null, "SIGTERM")
    expect(await pending).toMatchObject({
      kind: "media_duration_limit",
      phase: "decode",
      limit: 0.001,
      observed: 65 / 4 / 16_000,
    })
  })

  it("does not return partial samples", async () => {
    const child = fakeChild()
    const pending = decodeAudioFile(
      "/input",
      join(directory, "pcm"),
      1,
      new AbortController().signal,
    )
    child.stdout.end(Buffer.alloc(5))
    child.emit("close", 0)
    await expect(pending).rejects.toMatchObject({ kind: "transcription_failed", phase: "decode" })
  })
})
