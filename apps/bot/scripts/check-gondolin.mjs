// Offline VM acceptance: no model, Telegram, external API calls, or real credentials.
// Run after build. Pass a guest image directory to test a local build.
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { GondolinSandbox, SandboxCapacity } from "../dist/agent/gondolin.js"
import { vmBackendOptions } from "../dist/agent/vm-backend.js"

const namedImage = process.argv[2]
const backend = process.env.BOT_VM_BACKEND?.trim() || "qemu"
vmBackendOptions(backend)
console.log(`VM backend: ${backend}`)
const directory = await mkdtemp(path.join(tmpdir(), "sumire-gondolin-smoke-"))
const workspace = path.join(directory, "workspace")
await mkdir(workspace)
await writeFile(path.join(directory, "outside"), "private smoke fixture")
await symlink("../outside", path.join(workspace, "escape"))
const sandbox = new GondolinSandbox({
  backend,
  workspace,
  skills: [],
  image: namedImage ? path.resolve(namedImage) : undefined,
  allowedHosts: [],
  capacity: new SandboxCapacity(1),
  shellEnvironment: async () => ({}),
  authorize() {},
  authorizeShell: () => () => {},
})
const start = Date.now()
try {
  await sandbox.run("bash", undefined, 90, async (vm, signal) => {
    const result = await vm.exec(
      [
        "/bin/bash",
        "-lc",
        "set -e; uname -sr; printf retained > /workspace/retained; printf ephemeral > /tmp/ephemeral; otter --help >/dev/null; git --version; gh --version",
      ],
      { cwd: "/workspace", signal },
    )
    assert.equal(result.exitCode, 0, result.stderr.trim())
    console.log(result.stdout.trim())
    await assert.rejects(vm.fs.readFile("/workspace/escape", { signal }))
    await assert.rejects(vm.fs.writeFile("/workspace/escape", "changed", { signal }))
    assert.equal(await readFile(path.join(directory, "outside"), "utf8"), "private smoke fixture")
  })
  await sandbox.run("read", undefined, 90, async (vm, signal) => {
    assert.equal(
      await vm.fs.readFile("/workspace/retained", { encoding: "utf8", signal }),
      "retained",
    )
    await assert.rejects(vm.fs.access("/tmp/ephemeral", { signal }))
  })
  console.log(
    `PASS: guest commands, image tools, provider confinement, persistence and fresh rootfs; elapsed ${Date.now() - start}ms`,
  )
} finally {
  await sandbox.close()
  await rm(directory, { recursive: true, force: true })
}
