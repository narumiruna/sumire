import { describe, expect, it } from "vitest"
import { parseKey } from "../src/crypto.js"

const bytes = Buffer.alloc(32, 0xab)
const hex = bytes.toString("hex")
const base64 = bytes.toString("base64")

describe("master key encodings", () => {
  it.each([hex, hex.toUpperCase(), base64])("decodes a valid 32-byte key", (value) => {
    expect(parseKey(value)).toEqual(bytes)
  })
  it.each([
    undefined,
    "",
    "0".repeat(62),
    "0".repeat(63),
    "0".repeat(65),
    "0".repeat(66),
    "g".repeat(64),
    `0x${hex}`,
    ` ${hex}`,
    `${hex}\n`,
    base64.slice(0, -1),
    `${base64}\n`,
    Buffer.alloc(31).toString("base64"),
    Buffer.alloc(33).toString("base64"),
  ])("rejects malformed or incorrectly sized key material", (value) => {
    expect(parseKey(value)).toBeUndefined()
  })
})
