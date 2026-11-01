import { spawn } from "node:child_process"
import {
  CodemodeSandbox,
  CodemodeSandboxBase,
  type CodemodeSandboxOptions,
} from "@earendil-works/pi-codemode"

type ProcessSandboxOptions = Pick<CodemodeSandboxOptions, "memoryLimitBytes" | "onWorkerStarted">
type VmLauncher = ConstructorParameters<typeof CodemodeSandboxBase>[1]

// Only the official Pi VM runs here. Tools and the durable journal stay in the bot.
const childProgram = `
process.once("disconnect", () => process.exit(1))
if (process.versions.bun) process.exit(1)
const { Worker } = await import("node:worker_threads")
const { loadQuickJSWasm } = await import(process.argv[1])
const wasm = await loadQuickJSWasm()
process.once("message", (data) => {
  const worker = new Worker(new URL(process.argv[2]), {
    execArgv: [],
    workerData: { ...data, wasm, interrupt: new SharedArrayBuffer(4) },
  })
  process.on("message", (message) => worker.postMessage(message))
  worker.on("message", (message) => process.send(message))
  worker.once("error", () => process.exit(1))
  worker.once("exit", (code) => process.exit(code))
})
`

function nodeProcessLauncher(options: ProcessSandboxOptions): VmLauncher {
  return (data, events) => {
    const child = spawn(
      "node",
      [
        "--input-type=module",
        "--eval",
        childProgram,
        "--",
        import.meta.resolve("@earendil-works/pi-codemode"),
        import.meta.resolve("@earendil-works/pi-codemode/worker"),
      ],
      {
        env: { PATH: process.env.PATH },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "json",
      },
    )
    let stopping = false
    const exited = new Promise<void>((resolve) => child.once("close", () => resolve()))
    const fail = () => {
      if (!stopping) events.failure({ kind: "sandbox", message: "Codemode Node process failed" })
    }
    child.on("message", events.message)
    child.once("error", fail)
    child.once("exit", fail)
    const stop = async () => {
      stopping = true
      child.kill("SIGKILL")
      await exited
    }
    const post = (message: Parameters<typeof child.send>[0]) => {
      if (!child.connected) {
        fail()
        return
      }
      child.send(message, (error) => {
        if (error) fail()
      })
    }
    try {
      options.onWorkerStarted?.(exited)
      post(data)
    } catch (error) {
      void stop()
      throw error
    }
    return { post, stop }
  }
}

/** Bun cannot terminate some WASM built-ins; a Node process provides a kill boundary. */
export class NodeProcessCodemodeSandbox extends CodemodeSandboxBase {
  constructor(options: ProcessSandboxOptions = {}) {
    super(options, nodeProcessLauncher(options))
  }
}

export const RuntimeCodemodeSandbox = process.versions.bun
  ? NodeProcessCodemodeSandbox
  : CodemodeSandbox
