// Fixtures adapted from @narumitw/pi-codex-imagegen (MIT). See ../LICENSE.
import { deflateSync } from "node:zlib"

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data])
  let crc = 0xffffffff
  for (const byte of body) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  const header = Buffer.alloc(4)
  header.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([header, body, checksum])
}

// Two RGBA pixels: fully transparent red and half-transparent green.
const PIXELS = Buffer.from([0, 255, 0, 0, 0, 0, 255, 0, 128])
export function png(width = 2, height = 1, raster = PIXELS): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raster)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

// A real one-component, 1x1 baseline JPEG: DC zero, EOB, and one-bit codes.
export function jpeg(): Buffer {
  const segment = (marker: number, data: number[]) => {
    const size = Buffer.alloc(2)
    size.writeUInt16BE(data.length + 2)
    return Buffer.concat([Buffer.from([255, marker]), size, Buffer.from(data)])
  }
  const counts = [1, ...Array<number>(15).fill(0)]
  return Buffer.concat([
    Buffer.from([255, 216]),
    segment(0xdb, [0, ...Array<number>(64).fill(1)]),
    segment(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
    segment(0xc4, [0, ...counts, 0, 0x10, ...counts, 0]),
    segment(0xda, [1, 1, 0, 0, 63, 0]),
    Buffer.from([0x3f, 255, 217]),
  ])
}
export const WEBP = Buffer.from(
  "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
  "base64",
)
// Generated from a half-transparent red pixel; no codec is needed at test time.
export const WEBP_LOSSLESS = Buffer.from(
  "UklGRhwAAABXRUJQVlA4TBAAAAAvAAAAEM1VICIC0f9oYAIA",
  "base64",
)
export function extendedWebp(bytes: Buffer, flags = 0): Buffer {
  const header = Buffer.alloc(18)
  header.write("VP8X")
  header.writeUInt32LE(10, 4)
  header[8] = flags
  const riff = Buffer.from(bytes.subarray(0, 12))
  const body = Buffer.concat([header, bytes.subarray(12)])
  riff.writeUInt32LE(4 + body.length, 4)
  return Buffer.concat([riff, body])
}
export const PNG = png()
