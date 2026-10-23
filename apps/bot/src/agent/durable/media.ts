import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import { type DecodedImage, decodeImage, MAX_IMAGE_BYTES } from "@narumitw/sumire-imagegen"

export type GeneratedMedia = {
  id: string
  extension: "png" | "jpg" | "webp"
  mimeType: string
  width: number
  height: number
  byteLength: number
  sha256: string
  taskId: number
  callId: string
  messageId?: number
}
const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Original image bytes are private transport state, never model-selected paths. */
export class GeneratedMediaFiles {
  readonly directory: string
  constructor(durableDirectory: string) {
    this.directory = path.join(durableDirectory, "images")
  }

  async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Invalid image storage directory")
    await chmod(this.directory, 0o700)
  }

  private filename(media: Pick<GeneratedMedia, "id" | "extension">): string {
    if (!validId.test(media.id) || !["png", "jpg", "webp"].includes(media.extension))
      throw new Error("Invalid image receipt")
    return path.join(this.directory, `${media.id}.${media.extension}`)
  }

  async save(
    image: DecodedImage,
    signal?: AbortSignal,
  ): Promise<Omit<GeneratedMedia, "taskId" | "callId">> {
    signal?.throwIfAborted()
    const id = randomUUID()
    const receipt = {
      id,
      extension: image.extension,
      mimeType: image.mimeType,
      width: image.width,
      height: image.height,
      byteLength: image.bytes.length,
      sha256: createHash("sha256").update(image.bytes).digest("hex"),
    }
    const destination = this.filename(receipt)
    const temporary = `${destination}.tmp`
    let published = false
    try {
      await this.prepare()
      signal?.throwIfAborted()
      const file = await open(temporary, "wx", 0o600)
      try {
        await file.writeFile(image.bytes, { signal })
        signal?.throwIfAborted()
      } finally {
        await file.close()
      }
      signal?.throwIfAborted()
      await rename(temporary, destination)
      published = true
      signal?.throwIfAborted()
      return receipt
    } catch (error) {
      await rm(temporary, { force: true })
      if (published) await rm(destination, { force: true })
      throw error
    }
  }

  async read(media: GeneratedMedia): Promise<Buffer> {
    if (
      !Number.isSafeInteger(media.byteLength) ||
      media.byteLength < 1 ||
      media.byteLength > MAX_IMAGE_BYTES
    )
      throw new Error("Invalid image receipt")
    const info = await lstat(this.directory)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Invalid image storage directory")
    const file = await open(this.filename(media), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size !== media.byteLength)
        throw new Error("Generated image is missing or changed")
      // Bound reads independently of metadata, including concurrent file growth.
      const bytes = Buffer.alloc(media.byteLength + 1)
      let size = 0
      while (size < bytes.length) {
        const next = await file.read(bytes, size, bytes.length - size, size)
        if (!next.bytesRead) break
        size += next.bytesRead
      }
      if (
        size !== media.byteLength ||
        createHash("sha256").update(bytes.subarray(0, size)).digest("hex") !== media.sha256
      )
        throw new Error("Generated image is missing or changed")
      const decoded = decodeImage(bytes.subarray(0, size).toString("base64"))
      if (
        decoded.mimeType !== media.mimeType ||
        decoded.width !== media.width ||
        decoded.height !== media.height
      )
        throw new Error("Generated image is missing or changed")
      return decoded.bytes
    } finally {
      await file.close()
    }
  }

  async remove(media: Pick<GeneratedMedia, "id" | "extension">): Promise<void> {
    await rm(this.filename(media), { force: true })
  }

  /** Startup only, before Harness resumes. Never prune files while tools run. */
  async prune(referenced: readonly GeneratedMedia[]): Promise<void> {
    await this.prepare()
    const keep = new Set(referenced.map((item) => path.basename(this.filename(item))))
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        !keep.has(entry.name) &&
        /^[0-9a-f-]+\.(png|jpg|webp)(\.tmp)?$/.test(entry.name)
      )
        await rm(path.join(this.directory, entry.name), { force: true })
    }
  }
}
