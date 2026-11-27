import { constants } from "node:fs"
import { lstat, mkdir, realpath } from "node:fs/promises"
import path from "node:path"
import {
  createHttpHooks,
  ReadonlyProvider,
  RealFSProvider,
  VM,
  type VMOptions,
} from "@earendil-works/gondolin"
import { type VmBackend, vmBackendOptions } from "./vm-backend.js"

export const guestWorkdir = "/workspace"
const bundledGuestImage = "/opt/gondolin/guest"
const sandboxAllowedHosts = [
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "dl-cdn.alpinelinux.org",
  "otter.narumi.dev",
]

/** One capacity budget for the factory, not four VMs per chat. */
export class SandboxCapacity {
  private running = 0
  private readonly waiting: (() => void)[] = []
  constructor(private readonly limit = 4) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    while (this.running >= this.limit) {
      signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener("abort", abort)
          resolve()
        }
        const abort = () => {
          const index = this.waiting.indexOf(wake)
          if (index !== -1) this.waiting.splice(index, 1)
          reject(signal.reason)
        }
        this.waiting.push(wake)
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
      })
      // A waiter can be cancelled after release wakes it but before it claims the slot.
      if (signal.aborted && this.running < this.limit) this.waiting.shift()?.()
    }
    signal.throwIfAborted()
    this.running++
    let released = false
    return () => {
      if (released) return
      released = true
      this.running--
      this.waiting.shift()?.()
    }
  }
}

export interface GondolinOptions {
  backend?: VmBackend
  workspace: string
  skills: { name: string; filePath: string }[]
  image?: string
  allowedHosts?: string[]
  capacity: SandboxCapacity
  shellEnvironment(signal?: AbortSignal): Promise<NodeJS.ProcessEnv>
  authorize(name: string): void
  authorizeShell(): (environment: NodeJS.ProcessEnv) => void
}
export type CreateVm = (options: VMOptions) => Promise<VM>

/** Workspace files belong to a chat. VM, root disk, processes and /tmp belong to one tool call. */
export class GondolinSandbox {
  private closed = false
  private readonly controllers = new Set<AbortController>()
  private readonly pending = new Set<Promise<unknown>>()
  constructor(
    private readonly options: GondolinOptions,
    private readonly createVm: CreateVm = (options) => VM.create(options),
  ) {}

  async close(): Promise<void> {
    this.closed = true
    for (const controller of this.controllers) controller.abort(new Error("Sandbox closed"))
    await Promise.allSettled([...this.pending])
  }

  async run<T>(
    name: string,
    signal: AbortSignal | undefined,
    seconds: number,
    action: (vm: VM, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new Error("Sandbox is closed")
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3_600)
      throw new Error("Sandbox timeout must be greater than zero and at most 3600s")
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setTimeout(
      () => controller.abort(new Error(`Sandbox execution timed out after ${seconds} seconds`)),
      seconds * 1_000,
    )
    timer.unref()
    this.controllers.add(controller)
    const task = this.invoke(name, controller.signal, action)
    this.pending.add(task)
    try {
      return await task
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      this.controllers.delete(controller)
      this.pending.delete(task)
    }
  }

  private async invoke<T>(
    name: string,
    signal: AbortSignal,
    action: (vm: VM, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const release = await this.options.capacity.acquire(signal)
    let vm: VM | undefined
    let closing: Promise<void> | undefined
    const close = () => {
      if (vm && !closing) closing = vm.close()
      closing?.catch(() => {})
    }
    signal.addEventListener("abort", close, { once: true })
    try {
      signal.throwIfAborted()
      this.options.authorize(name)
      await mkdir(this.options.workspace, { recursive: true, mode: 0o700 })
      if ((await lstat(this.options.workspace)).isSymbolicLink())
        throw new Error("Sandbox workspace must not be a symlink")
      const mounts: NonNullable<VMOptions["vfs"]>["mounts"] = {
        [guestWorkdir]: new RealFSProvider(await realpath(this.options.workspace)),
      }
      for (const skill of this.options.skills) {
        if (!/^[a-z0-9][a-z0-9_-]*$/iu.test(skill.name))
          throw new Error("Invalid sandbox skill name")
        mounts[`/skills/${skill.name}`] = new ReadonlyProvider(
          new RealFSProvider(path.dirname(skill.filePath)),
        )
      }
      const validateShell = name === "bash" ? this.options.authorizeShell() : undefined
      const environment = name === "bash" ? await this.options.shellEnvironment(signal) : {}
      signal.throwIfAborted()
      validateShell?.(environment)
      const authorize = () => {
        signal.throwIfAborted()
        this.options.authorize(name)
        validateShell?.(environment)
      }
      const { httpHooks, env } = createHttpHooks({
        allowedHosts: this.options.allowedHosts ?? sandboxAllowedHosts,
        blockInternalRanges: true,
        secretPlaceholderMode: "unique",
        // Never substitute a credential onto an unencrypted HTTP connection.
        isRequestAllowed: (request) => new URL(request.url).protocol === "https:",
        onRequest: () => {
          authorize()
        },
        secrets: {
          ...(environment.GH_TOKEN
            ? { GH_TOKEN: { hosts: ["api.github.com", "github.com"], value: environment.GH_TOKEN } }
            : {}),
          ...(environment.OTTER_TOKEN
            ? { OTTER_TOKEN: { hosts: ["otter.narumi.dev"], value: environment.OTTER_TOKEN } }
            : {}),
        },
      })
      vm = await this.createVm({
        memory: "512M",
        cpus: 1,
        startTimeoutMs: 30_000,
        sessionLabel: "sumire coding tool",
        sandbox: {
          ...vmBackendOptions(this.options.backend ?? "qemu"),
          imagePath: this.options.image ?? bundledGuestImage,
          netEnabled: name === "bash",
        },
        rootfs: { mode: "cow" },
        dns: { mode: "synthetic" },
        allowWebSockets: false,
        httpHooks,
        env: {
          ...env,
          HOME: "/root",
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          GH_PROMPT_DISABLED: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
          GIT_CONFIG_VALUE_0: "!gh auth git-credential",
        },
        vfs: { mounts },
        debugLog: null,
      })
      // Image resolution in VM.create is not abortable. Drain and close a late VM;
      // never dispatch a command after cancellation or silently use host execution.
      authorize()
      await vm.start()
      authorize()
      return await action(vm, signal)
    } finally {
      close()
      try {
        await closing
      } finally {
        signal.removeEventListener("abort", close)
        release()
      }
    }
  }
}

export function guestPath(file: string): string {
  if (file.includes("\0")) throw new Error("Invalid guest path")
  if (file === "~" || file.startsWith("~/")) return path.posix.resolve("/root", file.slice(2))
  return path.posix.resolve(guestWorkdir, file)
}

export async function boundedFile(vm: VM, file: string, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of await vm.fs.readFileStream(guestPath(file), { signal })) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > 20_000_000) throw new Error("File exceeds 20000000 byte limit")
    chunks.push(bytes)
  }
  return Buffer.concat(chunks)
}

export async function imageType(
  vm: VM,
  file: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  await vm.fs.access(guestPath(file), { mode: constants.R_OK, signal })
  const stream = await vm.fs.readFileStream(guestPath(file), { signal, chunkSize: 64 })
  try {
    for await (const chunk of stream) {
      const b = Buffer.from(chunk)
      if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        return "image/png"
      if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg"
      if (b.subarray(0, 3).toString() === "GIF") return "image/gif"
      if (b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP")
        return "image/webp"
      if (b.subarray(0, 2).toString() === "BM") return "image/bmp"
      return undefined
    }
    return undefined
  } finally {
    stream.destroy()
  }
}
