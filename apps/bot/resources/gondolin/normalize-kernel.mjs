import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { gunzipSync } from "node:zlib"

function isArm64Image(bytes) {
  // The Linux ARM64 Image header stores its magic at offset 56.
  return bytes.length >= 64 && bytes.readUInt32LE(56) === 0x644d5241
}

async function normalizeGondolinKernel(directory) {
  const manifestPath = path.join(directory, "manifest.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  if (manifest.config.arch !== "aarch64") return

  const kernelPath = path.join(directory, manifest.assets.kernel)
  const kernel = await readFile(kernelPath)
  if (isArm64Image(kernel)) return

  // QEMU direct boot needs the Image inside Alpine's EFI zboot wrapper.
  if (
    kernel.length < 64 ||
    kernel.toString("ascii", 0, 2) !== "MZ" ||
    kernel.toString("ascii", 4, 8) !== "zimg"
  ) {
    throw new Error("Expected an ARM64 Linux Image or EFI zboot kernel")
  }
  const offset = kernel.readUInt32LE(8)
  const size = kernel.readUInt32LE(12)
  if (offset < 64 || size === 0 || offset + size > kernel.length) {
    throw new Error("Invalid ARM64 EFI zboot payload bounds")
  }
  const image = gunzipSync(kernel.subarray(offset, offset + size))
  if (!isArm64Image(image)) throw new Error("EFI zboot payload is not an ARM64 Linux Image")

  // Gondolin 0.14.0 does not export its manifest build-ID helper from the package entry point.
  const { computeAssetBuildId } = await import(
    new URL("assets.js", import.meta.resolve("@earendil-works/gondolin")).href
  )
  manifest.checksums.kernel = createHash("sha256").update(image).digest("hex")
  manifest.buildId = computeAssetBuildId({
    arch: manifest.config.arch,
    checksums: manifest.checksums,
  })
  await writeFile(kernelPath, image)
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

await normalizeGondolinKernel(process.argv[2])
