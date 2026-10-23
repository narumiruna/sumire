import { expect, it } from "vitest"
import { decodeImage, MAX_IMAGE_BYTES } from "../src/index.js"
import { extendedWebp, jpeg, PNG, png, WEBP, WEBP_LOSSLESS } from "./fixtures.js"

it.each([PNG, jpeg(), WEBP, WEBP_LOSSLESS, extendedWebp(WEBP)])(
  "accepts static original image bytes",
  (bytes) => {
    const image = decodeImage(bytes.toString("base64"))
    expect(image.bytes).toEqual(bytes)
    expect(image.width).toBeGreaterThan(0)
    expect(image.height).toBeGreaterThan(0)
  },
)
it.each(["", "a", "AAAA====", "YQ", "YQ== ", "AA-_", "data:image/png;base64,AA=="])(
  "rejects noncanonical Base64",
  (base64) => {
    expect(() => decodeImage(base64)).toThrow()
  },
)
it("bounds decoded bytes, dimensions and total pixels before decompression", () => {
  expect(() => decodeImage("A".repeat(4 * Math.ceil(MAX_IMAGE_BYTES / 3)))).toThrow()
  for (const dimensions of [
    [0, 1],
    [16_385, 1],
    [8192, 8192],
    [1, 16_385],
  ] as const)
    expect(() => decodeImage(png(...dimensions).toString("base64"))).toThrow()
})
it("rejects damaged, truncated, animated or mismatched containers", () => {
  const damaged = Buffer.from(PNG)
  damaged[damaged.length - 1] = damaged.readUInt8(damaged.length - 1) ^ 1
  for (const bytes of [
    damaged,
    PNG.subarray(0, -1),
    Buffer.concat([PNG, Buffer.from([0])]),
    jpeg().subarray(0, -1),
    WEBP.subarray(0, -1),
    extendedWebp(WEBP, 2),
  ])
    expect(() => decodeImage(bytes.toString("base64"))).toThrow()
})
