import assert from "node:assert/strict"
import {
  NodeProcessCodemodeSandbox,
  RuntimeCodemodeSandbox,
} from "../dist/agent/durable/codemode-runtime.js"

// No model, tools, credentials, or external requests. Exercise the runtime-selected VM.
assert.ok(process.versions.bun)
assert.equal(RuntimeCodemodeSandbox, NodeProcessCodemodeSandbox)
for (const reason of ["timeout", "abort", "close"]) {
  const exits = []
  let exited = 0
  let started = false
  const sandbox = new RuntimeCodemodeSandbox({
    memoryLimitBytes: 256 * 1024 * 1024,
    onWorkerStarted: (exit) => {
      exits.push(exit)
      void exit.then(() => exited++)
    },
  })
  const controller = new AbortController()
  try {
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
    assert.equal(started, true)
    assert.equal(result.ok, false)
    assert.equal(result.error.kind, reason === "timeout" ? "timeout" : "aborted")
    assert.equal(exited, exits.length, "A stopped VM process must exit before its result settles")
    assert.equal(exits.length, 1)
    if (reason !== "close") {
      const recovered = await sandbox.execute('return load("marker")', { store: { marker: 42 } })
      assert.equal(recovered.ok, true)
      assert.equal(recovered.value, 42)
    }
  } finally {
    await sandbox.close()
    await Promise.all(exits)
  }
}
console.log("Bun codemode: Node VM process exits on timeout, abort, and close; recovery passed")
