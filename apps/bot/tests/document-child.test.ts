import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"

import { afterEach, describe, expect, it, vi } from "vitest"

import { AnyDocConverter } from "../src/documents/converter.js"

vi.mock("node:child_process", () => ({ spawn: vi.fn() }))

afterEach(() => {
  vi.resetAllMocks()
  vi.useRealTimers()
})

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  })
}

describe("document child lifecycle", () => {
  it.each(["child", "stdin", "timeout"])(
    "retains conversion capacity until close after a %s error",
    async (source) => {
      if (source === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      const first = fakeChild()
      const second = fakeChild()
      vi.mocked(spawn)
        .mockReturnValueOnce(first as unknown as ReturnType<typeof spawn>)
        .mockReturnValueOnce(second as unknown as ReturnType<typeof spawn>)
      const converter = AnyDocConverter.forTesting({
        timeoutMs: 30_000,
        maxMarkdownChars: 100,
        maxConcurrency: 1,
      })
      let settled = false
      const failed = converter
        .convert(async () => Buffer.from("one"), "one.csv")
        .catch((error: unknown) => {
          settled = true
          return error
        })
      const loadQueued = vi.fn(async () => Buffer.from("two"))
      const queued = converter.convert(loadQueued, "two.csv")
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(spawn).toHaveBeenCalledOnce()

      const error = new Error(`${source} failed`)
      if (source === "child") first.emit("error", error)
      else if (source === "stdin") first.stdin.emit("error", error)
      else await vi.advanceTimersByTimeAsync(30_000)
      await new Promise<void>((resolve) => setImmediate(resolve))
      const settledBeforeClose = settled
      const spawnedBeforeClose = vi.mocked(spawn).mock.calls.length
      const loadedBeforeClose = loadQueued.mock.calls.length

      first.emit("close", null, "SIGKILL")
      await new Promise<void>((resolve) => setImmediate(resolve))
      second.stdout.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            ok: true,
            format: "csv",
            markdown: "converted",
            originalChars: 9,
            truncated: false,
          }),
        ),
      )
      second.emit("close", 0, null)

      if (source === "timeout") expect(await failed).toMatchObject({ kind: "timeout" })
      else expect(await failed).toBe(error)
      await expect(queued).resolves.toMatchObject({ markdown: "converted" })
      expect(first.kill).toHaveBeenCalledWith("SIGKILL")
      expect(settledBeforeClose).toBe(false)
      expect(spawnedBeforeClose).toBe(1)
      expect(loadedBeforeClose).toBe(0)
      expect(loadQueued).toHaveBeenCalledOnce()
      expect(spawn).toHaveBeenCalledTimes(2)
    },
  )
})
