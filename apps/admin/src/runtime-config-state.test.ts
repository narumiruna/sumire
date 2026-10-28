import type { RuntimeConfigResponse } from "@narumitw/sumire-contracts"
import { describe, expect, it } from "vitest"
import { storedReference } from "./mcp-reference-editor.js"
import { parseRuntimeConfig, runtimeValueError } from "./runtime-config-state.js"

const response: RuntimeConfigResponse = {
  revision: 3,
  applied: 2,
  status: "failed",
  secretStatus: "ready",
  entries: [
    { name: "TOKEN", kind: "secret", configured: true, updatedAt: 1000, revision: 3 },
    { name: "PUBLIC", kind: "variable", value: " <script> & \n ", updatedAt: 1000, revision: 2 },
  ],
}

describe("runtime management metadata", () => {
  it("retains committed application failure and only safe response fields", () => {
    const untrusted = structuredClone(response)
    Object.assign(untrusted.entries[0] ?? {}, {
      value: "SENTINEL-NEVER-RETAIN",
      payload: "SENTINEL-NEVER-RETAIN",
    })
    const parsed = parseRuntimeConfig(untrusted)
    expect(parsed).toEqual(response)
    expect(JSON.stringify(parsed)).not.toContain("SENTINEL")
  })
  it.each([
    null,
    {},
    { ...response, revision: 0 },
    { ...response, applied: -1 },
    { ...response, secretStatus: "raw-error" },
    { ...response, entries: [{ ...response.entries[0], updatedAt: "date" }] },
    { ...response, entries: [{ ...response.entries[0], kind: "other" }] },
  ])("rejects an unsafe revision base", (value) => {
    expect(() => parseRuntimeConfig(value as RuntimeConfigResponse)).toThrow()
  })
  it("validates bounded names and exact UTF-8 values without trimming", () => {
    expect(runtimeValueError("TOKEN", "secret", " ")).toBe("")
    expect(runtimeValueError("PUBLIC", "variable", "")).toBe("")
    expect(runtimeValueError("TOKEN", "secret", "")).not.toBe("")
    expect(runtimeValueError("TOKEN", "secret", "é".repeat(4096))).toBe("")
    expect(runtimeValueError("TOKEN", "secret", "é".repeat(4097))).toMatch(/8 KiB/)
    for (const name of [
      "lower",
      "1KEY",
      "A".repeat(129),
      "BOT_TOKEN",
      "BOT_ADMIN_ID",
      "LOGFIRE_TOKEN",
      "ADMIN_PORT",
      "SUMIRE_SECRETS_KEY",
    ])
      expect(runtimeValueError(name, "variable", "x")).not.toBe("")
  })
  it("uses explicit stored references, not decrypted copies or ambient names", () => {
    expect(storedReference("TOKEN", "Bearer ")).toBe(`Bearer \${TOKEN}`)
    expect(storedReference("PUBLIC")).toBe(`\${PUBLIC}`)
    expect(() => storedReference("bad-name")).toThrow()
  })
})
