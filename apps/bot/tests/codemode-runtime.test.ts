import {
  type CodemodeHostCall,
  type CodemodeRun,
  CodemodeSandbox,
  type CodemodeSandboxBase,
} from "@earendil-works/pi-codemode"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NodeProcessCodemodeSandbox } from "../src/agent/durable/codemode-runtime.js"

const sandboxes: CodemodeSandboxBase[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(sandboxes.splice(0).map((sandbox) => sandbox.close()))
})

async function deterministicRun(sandbox: CodemodeSandboxBase) {
  sandboxes.push(sandbox)
  let fingerprint: string | undefined
  const calls: CodemodeHostCall[] = []
  let run: CodemodeRun
  run = sandbox.start(
    'const value = await tools.echo(load("before")); store("after", value); text(value); return [Date.now(), Math.random(), value]',
    {
      startedAt: 1000,
      seed: 7,
      tools: [{ name: "echo" }],
      store: { before: { nested: [1, null, "text"] } },
      onStarted: (value) => {
        fingerprint = value
      },
      onCall: (call) => {
        calls.push(call)
        run.deliver(calls.length, 2000, call.id, { ok: true, value: call.args })
      },
    },
  )
  const result = await run.result
  return { fingerprint, calls, result }
}

describe("Node codemode process boundary", () => {
  it("preserves the native VM fingerprint, deterministic calls, output, and store", async () => {
    const native = await deterministicRun(new CodemodeSandbox())
    const child = await deterministicRun(new NodeProcessCodemodeSandbox())
    expect(child.fingerprint).toBe(native.fingerprint)
    expect(child.calls).toEqual(native.calls)
    expect(child.result).toMatchObject({ ok: true, value: native.result.ok && native.result.value })
    expect(child.result.output).toEqual(native.result.output)
    if (!child.result.ok || !native.result.ok) throw new Error("Expected deterministic success")
    expect(child.result.storeWrites).toEqual(native.result.storeWrites)
    expect(child.result.during).toEqual(native.result.during)
  })

  it.each(["timeout", "abort", "close"] as const)(
    "waits for actual process exit after %s during a non-interruptible builtin",
    async (reason) => {
      let exited = false
      let started = false
      const sandbox = new NodeProcessCodemodeSandbox({
        onWorkerStarted: (exit) => {
          void exit.then(() => {
            exited = true
          })
        },
      })
      sandboxes.push(sandbox)
      const controller = new AbortController()
      const run = sandbox.start('"a".repeat(200000).indexOf("a".repeat(100000) + "b")', {
        startedAt: 1000,
        seed: 7,
        timeoutMs: 1000,
        signal: controller.signal,
        onCall() {},
        onStarted: () => {
          started = true
          if (reason !== "timeout")
            setTimeout(() => {
              if (reason === "abort") controller.abort()
              else void sandbox.close()
            }, 20)
        },
      })
      const result = await run.result
      expect(started).toBe(true)
      expect(exited).toBe(true)
      expect(result).toMatchObject({
        ok: false,
        error: { kind: reason === "timeout" ? "timeout" : "aborted" },
      })
      if (reason !== "close")
        await expect(sandbox.execute("return 'recovered'")).resolves.toMatchObject({
          ok: true,
          value: "recovered",
        })
    },
    10_000,
  )

  it("reports a missing Node executable without leaving a pending process", async () => {
    vi.stubEnv("PATH", "/nonexistent-node-directory")
    let exited: Promise<void> | undefined
    const sandbox = new NodeProcessCodemodeSandbox({
      onWorkerStarted: (exit) => {
        exited = exit
      },
    })
    sandboxes.push(sandbox)
    await expect(sandbox.execute("return 1")).resolves.toMatchObject({
      ok: false,
      error: { kind: "sandbox" },
    })
    await exited
  })
})
