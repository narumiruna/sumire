import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { gzipSync } from "node:zlib"
import { afterEach, beforeEach, expect, it } from "vitest"

const exec = promisify(execFile)
const script = fileURLToPath(new URL("../resources/gondolin/normalize-kernel.mjs", import.meta.url))
const normalizeGondolinKernel = (directory: string) => exec(process.execPath, [script, directory])

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "sumire-kernel-"))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const arm64Image = Buffer.alloc(128)
arm64Image.write("41524d64", 56, "hex")
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

function zboot(image: Buffer) {
  const gzip = gzipSync(image)
  const header = Buffer.alloc(64)
  header.write("MZ")
  header.write("zimg", 4)
  header.writeUInt32LE(header.length, 8)
  header.writeUInt32LE(gzip.length, 12)
  // EFI section alignment can leave bytes after the declared payload.
  return Buffer.concat([header, gzip, Buffer.alloc(10, 255)])
}

async function fixture(kernel: Buffer, arch = "aarch64") {
  const manifest = {
    config: { arch },
    assets: { kernel: "vmlinuz-virt" },
    checksums: { kernel: digest(kernel), initramfs: "initramfs-sha", rootfs: "rootfs-sha" },
    buildId: "original-build-id",
  }
  const kernelPath = path.join(directory, manifest.assets.kernel)
  const manifestPath = path.join(directory, "manifest.json")
  await writeFile(kernelPath, kernel)
  await writeFile(manifestPath, JSON.stringify(manifest))
  return {
    manifest,
    readKernel: () => readFile(kernelPath),
    readManifest: async () => JSON.parse(await readFile(manifestPath, "utf8")),
  }
}

it("replaces an ARM64 EFI zboot wrapper with the Linux Image and updates its manifest", async () => {
  const files = await fixture(zboot(arm64Image))
  await normalizeGondolinKernel(directory)
  expect(await files.readKernel()).toEqual(arm64Image)
  const manifest = await files.readManifest()
  expect(manifest).toEqual({
    ...files.manifest,
    buildId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    checksums: { ...files.manifest.checksums, kernel: digest(arm64Image) },
  })
  await normalizeGondolinKernel(directory)
  expect(await files.readManifest()).toEqual(manifest)
})

it.each([
  { arch: "x86_64", kernel: Buffer.from("x86 kernel") },
  { arch: "aarch64", kernel: arm64Image },
])("leaves $arch kernels that need no conversion unchanged", async ({ arch, kernel }) => {
  const files = await fixture(kernel, arch)
  await normalizeGondolinKernel(directory)
  expect(await files.readKernel()).toEqual(kernel)
  expect(await files.readManifest()).toEqual(files.manifest)
})

it("rejects a truncated EFI zboot payload without changing the image or manifest", async () => {
  const kernel = zboot(arm64Image).subarray(0, 70)
  const files = await fixture(kernel)
  await expect(normalizeGondolinKernel(directory)).rejects.toThrow(
    "Invalid ARM64 EFI zboot payload",
  )
  expect(await files.readKernel()).toEqual(kernel)
  expect(await files.readManifest()).toEqual(files.manifest)
})

it("rejects an EFI zboot payload that is not an ARM64 Linux Image", async () => {
  await fixture(zboot(Buffer.alloc(128)))
  await expect(normalizeGondolinKernel(directory)).rejects.toThrow("not an ARM64 Linux Image")
})
