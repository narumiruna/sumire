import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"

import { afterEach, describe, expect, it, vi } from "vitest"
import { runAnyDocChild } from "../src/core/anydoc.js"

vi.mock("node:child_process", () => ({ spawn: vi.fn() }))

afterEach(() => {
  vi.resetAllMocks()
  vi.unstubAllGlobals()
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

describe("shared AnyDoc child", () => {
  it("does not start a child for an already cancelled request", async () => {
    const reason = new Error("cancelled")
    await expect(
      runAnyDocChild(Buffer.from("a,b"), "data.csv", 100, 1000, AbortSignal.abort(reason)),
    ).rejects.toBe(reason)
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each(["abort", "timeout", "stdout"])(
    "kills on %s but waits for close before settling",
    async (failure) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      const child = fakeChild()
      vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
      const controller = new AbortController()
      const reason = new Error("cancelled")
      let settled = false
      const result = runAnyDocChild(Buffer.from("a,b"), "data.csv", 100, 1000, controller.signal)
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true
        })
      if (failure === "abort") controller.abort(reason)
      else if (failure === "timeout") await vi.advanceTimersByTimeAsync(1000)
      else child.stdout.emit("data", Buffer.alloc(64_001))
      await Promise.resolve()
      expect(child.kill).toHaveBeenCalledWith("SIGKILL")
      expect(settled).toBe(false)
      child.emit("close", null, "SIGKILL")
      if (failure === "abort") expect(await result).toBe(reason)
      else
        expect(await result).toMatchObject({
          kind: failure === "timeout" ? "timeout" : "resourceLimit",
        })
      const kills = child.kill.mock.calls.length
      controller.abort(reason)
      await vi.advanceTimersByTimeAsync(1000)
      expect(child.kill).toHaveBeenCalledTimes(kills)
    },
  )

  it.each([undefined, "1.4.4"])(
    "disables automatic .env loading only for Bun children (version: %s)",
    async (bun) => {
      vi.stubGlobal("process", { ...process, versions: { ...process.versions, bun } })
      const child = fakeChild()
      vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
      const result = runAnyDocChild(Buffer.from("a,b"), "data.csv", 100, 1000)
      const call = vi.mocked(spawn).mock.calls[0]
      expect(call?.[0]).toBe(process.execPath)
      const args = call?.[1] as readonly string[]
      expect(args.slice(0, args.indexOf("--eval") + 1)).toEqual([
        ...(bun ? ["--no-env-file"] : []),
        "--input-type=module",
        "--eval",
      ])
      child.stdout.emit("data", Buffer.from(JSON.stringify({ ok: true, markdown: "table" })))
      child.emit("close", 0, null)
      await expect(result).resolves.toMatchObject({ ok: true, markdown: "table" })
    },
  )

  it("resolves the adapter relative to its package and explicitly disables hosted OCR", async () => {
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
    const controller = new AbortController()
    const result = runAnyDocChild(Buffer.from("a,b"), "data.csv", 100, 1000, controller.signal)
    const args = vi.mocked(spawn).mock.calls[0]?.[1] as string[]
    expect(args[args.indexOf("--eval") + 1]).toContain('ocr: "reject"')
    expect(args.at(-1)).toBe(import.meta.resolve("@firecrawl/anydoc"))
    expect(args.at(-1)).toMatch(/^file:/u)
    child.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          ok: true,
          format: "csv",
          markdown: "table",
          originalChars: 5,
          truncated: false,
        }),
      ),
    )
    child.emit("close", 0, null)
    await expect(result).resolves.toMatchObject({ ok: true, markdown: "table" })
    controller.abort()
    expect(child.kill).not.toHaveBeenCalled()
  })
})
