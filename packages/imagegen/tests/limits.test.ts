import { inflateSync } from "node:zlib"
import { beforeEach, expect, it, vi } from "vitest"
import { decodeImage, MAX_IMAGE_BYTES } from "../src/index.js"
import { jpeg, PNG, png, WEBP } from "./fixtures.js"

vi.mock("node:zlib", async (original) => {
  const actual = await original<typeof import("node:zlib")>()
  return { ...actual, inflateSync: vi.fn(actual.inflateSync) }
})
beforeEach(() => vi.clearAllMocks())
it("applies tighter feedback dimensions/pixel limits before inflating a 16-bit PNG", () => {
  const image = png(4096, 4096, Buffer.alloc(0), 16).toString("base64")
  expect(() =>
    decodeImage(image, { maxDimension: 4096, maxPixels: 4_194_304, maxBytes: 2 * 1024 * 1024 }),
  ).toThrow("dimensions exceed")
  expect(inflateSync).not.toHaveBeenCalled()
})
it("retains full validation for images within the caller's bounds", () => {
  expect(
    decodeImage(PNG.toString("base64"), {
      maxDimension: 4096,
      maxPixels: 4_194_304,
      maxBytes: PNG.length,
    }).bytes,
  ).toEqual(PNG)
  expect(inflateSync).toHaveBeenCalledOnce()
  const damaged = Buffer.from(PNG)
  damaged[damaged.length - 1] = damaged.readUInt8(damaged.length - 1) ^ 1
  expect(() => decodeImage(damaged.toString("base64"), { maxPixels: 4_194_304 })).toThrow()
})
it.each([PNG, jpeg(), WEBP])(
  "checks caller byte limits exactly for every supported format",
  (image) => {
    expect(decodeImage(image.toString("base64"), { maxBytes: image.length }).bytes).toEqual(image)
    expect(() => decodeImage(image.toString("base64"), { maxBytes: image.length - 1 })).toThrow()
  },
)
it("does not allow custom limits to weaken the built-in ceilings", () => {
  for (const limits of [
    { maxBytes: MAX_IMAGE_BYTES + 1 },
    { maxDimension: 16385 },
    { maxPixels: 16_777_217 },
    { maxPixels: 0 },
    { maxDimension: Infinity },
  ])
    expect(() => decodeImage(PNG.toString("base64"), limits)).toThrow("Invalid image limit")
})
