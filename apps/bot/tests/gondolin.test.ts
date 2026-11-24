import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"
import { ReadonlyProvider, RealFSProvider, VM, type VMOptions } from "@earendil-works/gondolin"
import { afterEach, expect, it, vi } from "vitest"
import { McpAdmin } from "../src/admin/mcp.js"
import {
  GondolinSandbox,
  guestPath,
  SandboxCapacity,
  type GondolinOptions,
} from "../src/agent/gondolin.js"
import { createPiSessionFactory } from "../src/agent/pi-session-factory.js"
import { loadSettings } from "../src/config/settings.js"
import { callDurableTool } from "./helpers/durable-session.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function options(overrides: Partial<GondolinOptions> = {}): Promise<GondolinOptions> {
  const root = await mkdtemp(path.join(tmpdir(), "sumire-gondolin-"))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  return {
    workspace: path.join(root, "workspace"),
    skills: [],
    allowedHosts: ["api.github.com"],
    capacity: new SandboxCapacity(),
    shellEnvironment: async () => ({}),
    authorize: () => {},
    authorizeShell: () => () => {},
    ...overrides,
  }
}

function fakeVm() {
  return { start: vi.fn(async () => {}), close: vi.fn(async () => {}) } as unknown as VM
}

it("closes every invocation on success and failure, with no host fallback", async () => {
  const vms = [fakeVm(), fakeVm()]
  const create = vi.fn(async () => vms[create.mock.calls.length - 1] as VM)
  const sandbox = new GondolinSandbox(await options(), create)
  await expect(sandbox.run("read", undefined, 5, async () => "done")).resolves.toBe("done")
  await expect(
    sandbox.run("write", undefined, 5, async () => {
      throw new Error("failed")
    }),
  ).rejects.toThrow("failed")
  for (const vm of vms) {
    expect(vm.start).toHaveBeenCalledOnce()
    expect(vm.close).toHaveBeenCalledOnce()
  }
  const unavailable = new GondolinSandbox(await options(), async () => {
    throw new Error("no VMM")
  })
  const action = vi.fn()
  await expect(unavailable.run("bash", undefined, 5, action)).rejects.toThrow("no VMM")
  expect(action).not.toHaveBeenCalled()
})

it("puts placeholders, not ambient credentials or host paths, into VM options", async () => {
  const vm = fakeVm()
  let captured: VMOptions | undefined
  const sandbox = new GondolinSandbox(
    await options({
      shellEnvironment: async () => ({
        GH_TOKEN: "fixture-gh-secret",
        OTTER_TOKEN: "fixture-otter-secret",
        BOT_TOKEN: "must-not-enter",
        PATH: "/host/bin",
        HOME: "/host/home",
      }),
    }),
    async (o) => {
      captured = o
      return vm
    },
  )
  await sandbox.run("bash", undefined, 5, async () => {})
  expect(captured).toMatchObject({
    memory: "512M",
    cpus: 1,
    allowWebSockets: false,
    rootfs: { mode: "cow" },
    dns: { mode: "synthetic" },
  })
  expect(captured?.env).toMatchObject({ HOME: "/root", GH_PROMPT_DISABLED: "1" })
  const env = captured?.env as Record<string, string>
  expect(env.GH_TOKEN).toBeTruthy()
  expect(env.GH_TOKEN).not.toBe("fixture-gh-secret")
  expect(env.OTTER_TOKEN).not.toBe("fixture-otter-secret")
  expect(env).not.toHaveProperty("BOT_TOKEN")
  expect(env.PATH).toBe("/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
  expect(Object.keys(captured?.vfs?.mounts ?? {})).toEqual(["/workspace"])
  expect(
    await captured?.httpHooks?.isRequestAllowed?.(new Request("https://api.github.com/user")),
  ).toBe(true)
  expect(
    await captured?.httpHooks?.isRequestAllowed?.(new Request("http://api.github.com/user")),
  ).toBe(false)
  expect(
    await captured?.httpHooks?.isIpAllowed?.({
      hostname: "example.com",
      ip: "93.184.216.34",
      family: 4,
      port: 443,
      protocol: "https",
    }),
  ).toBe(false)
  const isIpAllowed = captured?.httpHooks?.isIpAllowed
  for (const ip of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1"]) {
    expect(
      await isIpAllowed?.({
        hostname: "api.github.com",
        ip,
        family: ip.includes(":") ? 6 : 4,
        port: 443,
        protocol: "https",
      }),
    ).toBe(false)
  }
})

it("rechecks authorization after image resolution, before any guest command", async () => {
  let allowed = true
  const vm = fakeVm()
  const sandbox = new GondolinSandbox(
    await options({
      authorize: () => {
        if (!allowed) throw new Error("revoked")
      },
    }),
    async () => {
      allowed = false
      return vm
    },
  )
  const action = vi.fn()
  await expect(sandbox.run("read", undefined, 5, action)).rejects.toThrow("revoked")
  expect(action).not.toHaveBeenCalled()
  expect(vm.start).not.toHaveBeenCalled()
  expect(vm.close).toHaveBeenCalledOnce()
})

it("drains and closes a late VM on cancellation during creation", async () => {
  const vm = fakeVm()
  let finish = (_vm: VM) => {}
  let entered = () => {}
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve
  })
  const sandbox = new GondolinSandbox(await options(), () => {
    entered()
    return new Promise<VM>((resolve) => {
      finish = resolve
    })
  })
  const controller = new AbortController()
  const action = vi.fn()
  const result = sandbox.run("bash", controller.signal, 5, action)
  const rejection = expect(result).rejects.toThrow("cancel fixture")
  await enteredPromise
  controller.abort(new Error("cancel fixture"))
  finish(vm)
  await rejection
  expect(action).not.toHaveBeenCalled()
  expect(vm.close).toHaveBeenCalledOnce()
})

it("aborts running work on shutdown and refuses new calls", async () => {
  const vm = fakeVm()
  const sandbox = new GondolinSandbox(await options(), async () => vm)
  let entered = () => {}
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const result = sandbox.run("bash", undefined, 5, async (_vm, signal) => {
    entered()
    await delay(60_000, undefined, { signal })
  })
  const rejection = expect(result).rejects.toThrow()
  await started
  await sandbox.close()
  await rejection
  expect(vm.close).toHaveBeenCalledOnce()
  await expect(sandbox.run("read", undefined, 5, async () => {})).rejects.toThrow("closed")
})

it("bounds running VMs and removes cancelled capacity waiters", async () => {
  const pool = new SandboxCapacity(1)
  const release = await pool.acquire(new AbortController().signal)
  const controller = new AbortController()
  const waiting = pool.acquire(controller.signal)
  const rejected = expect(waiting).rejects.toThrow("withdraw")
  controller.abort(new Error("withdraw"))
  await rejected
  release()
  const next = await pool.acquire(new AbortController().signal)
  next()
  next()
})

it("rejects symlink workspace roots and maps traversal only in the guest namespace", async () => {
  const settings = await options()
  await mkdir(path.dirname(settings.workspace), { recursive: true })
  const target = path.join(path.dirname(settings.workspace), "private")
  await mkdir(target)
  await symlink(target, settings.workspace)
  const create = vi.fn(async () => fakeVm())
  const sandbox = new GondolinSandbox(settings, create)
  await expect(sandbox.run("read", undefined, 5, async () => {})).rejects.toThrow("symlink")
  expect(create).not.toHaveBeenCalled()
  expect(guestPath("../../.telegramagent/admin.sqlite")).toBe("/.telegramagent/admin.sqlite")
  expect(guestPath("~/file")).toBe("/root/file")
})

it("uses Gondolin's actual host provider to reject escaping symlinks", async () => {
  const settings = await options()
  await mkdir(settings.workspace)
  await writeFile(path.join(path.dirname(settings.workspace), "outside"), "private fixture")
  await symlink("../outside", path.join(settings.workspace, "escape"))
  const provider = new RealFSProvider(settings.workspace)
  await expect(provider.open("/escape", "r")).rejects.toThrow()
})

/** Only the VM transport is mocked; factory, durable tools and nested CodeMode are real. */
it("routes production direct and CodeMode coding tools to the same chat-only mount", async () => {
  const fixture = await createPiFixture()
  cleanup.push(() => fixture.cleanup())
  const vmOptions: VMOptions[] = []
  const execs: string[][] = []
  const closes: ReturnType<typeof vi.fn>[] = []
  vi.spyOn(VM, "create").mockImplementation(async (o = {}) => {
    vmOptions.push(o)
    const mount = o.vfs?.mounts?.["/workspace"]
    if (!(mount instanceof RealFSProvider)) throw new Error("Missing workspace mount")
    const root = mount.rootPath
    const file = async (p: string, writing = false) => {
      if (!p.startsWith("/workspace/")) throw new Error("Unmapped guest path")
      const mapped = path.join(root, p.slice("/workspace/".length))
      const parent = await realpath(writing ? path.dirname(mapped) : mapped)
      if (parent !== root && !parent.startsWith(`${root}/`)) throw new Error("outside workspace")
      return mapped
    }
    const close = vi.fn(async () => {})
    closes.push(close)
    return {
      start: vi.fn(async () => {}),
      close,
      fs: {
        access: async (p: string) => {
          await file(p)
        },
        readFileStream: async (p: string) => Readable.from([await readFile(await file(p))]),
        mkdir: async (p: string) => {
          if (!p.startsWith("/workspace")) throw new Error("Unmapped")
          await mkdir(path.join(root, p.slice("/workspace".length)), { recursive: true })
        },
        writeFile: async (p: string, content: string) => writeFile(await file(p, true), content),
        deleteFile: async () => {},
      },
      exec: (command: string[]) => {
        execs.push(command)
        const result = Promise.resolve({ exitCode: 0 })
        return Object.assign(result, {
          async *output() {
            yield { text: "guest-only", data: Buffer.from("guest-only"), stream: "stdout" }
          },
        })
      },
    } as unknown as VM
  })
  const factory = await createPiSessionFactory(
    fixture.settings,
    fixture.logger,
    {
      store: fixture.factory.control,
      runtime: fixture.factory.runtime,
      mcp: new McpAdmin(
        fixture.factory.control,
        fixture.settings.botWorkdir,
        fixture.factory.runtime,
      ),
    },
    undefined,
    fixture.modelRuntime,
  )
  const session = await factory.create(123)
  cleanup.push(() => session.dispose())
  expect(session.cwd).toBe("/workspace")
  expect(session.systemPrompt).toContain("disposable Gondolin")
  await callDurableTool(session, "write", { path: "answer.txt", content: "before\nsecond\nthird" })
  await callDurableTool(session, "edit", {
    path: "answer.txt",
    edits: [{ oldText: "before", newText: "after" }],
  })
  const read = await callDurableTool(session, "read", { path: "answer.txt", offset: 2, limit: 1 })
  expect(read.isError).toBeFalsy()
  expect(JSON.stringify(read.content)).toContain("second")
  await callDurableTool(session, "write", {
    path: "large.txt",
    content: Array.from({ length: 2_100 }, (_, i) => `line-${i}`).join("\n"),
  })
  const bounded = await callDurableTool(session, "read", { path: "large.txt" })
  expect(bounded.isError).toBeFalsy()
  const boundedText = bounded.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
  expect(boundedText).toContain("line-1999")
  expect(boundedText).not.toContain("line-2000")
  await callDurableTool(session, "write", { path: "long-line.txt", content: "x".repeat(100_000) })
  const oversized = await callDurableTool(session, "read", { path: "long-line.txt" })
  expect(oversized.isError).toBe(true)
  expect(JSON.stringify(oversized.content)).toContain("exceeds 50KB")
  const nested = await callDurableTool(session, "codemode", {
    code: 'text(await tools.read({path:"answer.txt"})); text(await tools.bash({command:"uname -a"}))',
  })
  expect(nested.isError).toBeFalsy()
  expect(JSON.stringify(nested.content)).toContain("after")
  expect(JSON.stringify(nested.content)).toContain("guest-only")
  expect(execs.at(-1)?.slice(-2, -1)).toEqual(["uname -a"])
  expect(closes.every((close) => close.mock.calls.length === 1)).toBe(true)
  for (const o of vmOptions) {
    for (const [target, mount] of Object.entries(o.vfs?.mounts ?? {})) {
      if (target !== "/workspace") {
        expect(target).toMatch(/^\/skills\//u)
        expect(mount).toBeInstanceOf(ReadonlyProvider)
      }
    }
  }
  const inaccessible = await callDurableTool(session, "read", {
    path: fixture.settings.botSystemPromptPath,
  })
  expect(inaccessible.isError).toBe(true)
  const peer = await factory.create(456)
  cleanup.push(() => peer.dispose())
  const missing = await callDurableTool(peer, "read", { path: "answer.txt" })
  expect(missing.isError).toBe(true)
})

it("validates operator egress settings, including an explicit deny-all policy", () => {
  expect(
    loadSettings({ BOT_ADMIN_ID: "7", BOT_SANDBOX_ALLOWED_HOSTS: "[]" }).botSandboxAllowedHosts,
  ).toEqual([])
  expect(() => loadSettings({ BOT_ADMIN_ID: "7", BOT_SANDBOX_ALLOWED_HOSTS: '["*"]' })).toThrow()
  expect(() =>
    loadSettings({ BOT_ADMIN_ID: "7", BOT_SANDBOX_ALLOWED_HOSTS: '["https://example.com"]' }),
  ).toThrow()
  expect(() => loadSettings({ BOT_ADMIN_ID: "7", BOT_SANDBOX_ALLOWED_HOSTS: "invalid" })).toThrow()
})

it("closes the whole VM on a command deadline and validates timeouts before creation", async () => {
  const vm = fakeVm()
  const create = vi.fn(async () => vm)
  const sandbox = new GondolinSandbox(await options(), create)
  for (const seconds of [0, -1, Number.POSITIVE_INFINITY, 3_601]) {
    await expect(sandbox.run("bash", undefined, seconds, async () => {})).rejects.toThrow("timeout")
  }
  expect(create).not.toHaveBeenCalled()
  await expect(
    sandbox.run("bash", undefined, 0.03, async (_vm, signal) => {
      await delay(60_000, undefined, { signal })
    }),
  ).rejects.toThrow()
  expect(vm.close).toHaveBeenCalledOnce()
})

it("uses an actual read-only provider for the approved skill, not a writable parent mount", async () => {
  const settings = await options()
  const skill = path.join(path.dirname(settings.workspace), "skill")
  await mkdir(skill)
  await writeFile(path.join(skill, "SKILL.md"), "fixture instructions")
  let captured: VMOptions | undefined
  const sandbox = new GondolinSandbox(
    { ...settings, skills: [{ name: "fixture", filePath: path.join(skill, "SKILL.md") }] },
    async (o) => {
      captured = o
      return fakeVm()
    },
  )
  await sandbox.run("read", undefined, 5, async () => {})
  const provider = captured?.vfs?.mounts?.["/skills/fixture"]
  expect(provider).toBeInstanceOf(ReadonlyProvider)
  await expect(provider?.open("/SKILL.md", "w")).rejects.toThrow()
  expect(await readFile(path.join(skill, "SKILL.md"), "utf8")).toBe("fixture instructions")
})
