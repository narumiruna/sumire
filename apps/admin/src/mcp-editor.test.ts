import { afterEach, describe, expect, it } from "vitest"
import { setLocale } from "./i18n.js"
import { mcpChangePreview, mcpSavePatch, parseMcpPatch } from "./mcp-editor.js"

const previous = {
  name: "fixture",
  connection: "not tested",
  tools: [],
  fields: ["command", "args", "env"],
  env: { OLD: null, REMOVE: null },
  headers: {},
}
afterEach(() => setLocale("en"))

describe("MCP patch and preview", () => {
  it.each([
    ["zh-TW", "保留：env.OLD", "新增：env.NEW", "逾時必須為正數。"],
    ["ja", "保持：env.OLD", "追加：env.NEW", "タイムアウトには正の数が必要です。"],
  ] as const)(
    "localizes %s operations but not patches or secret field identifiers",
    (locale, retained, added, timeout) => {
      setLocale(locale)
      const patch = mcpSavePatch("{}", previous, { env: { NEW: "sentinel-secret" }, headers: {} })
      expect(patch).toEqual({ env: { OLD: null, REMOVE: null, NEW: "sentinel-secret" } })
      const preview = mcpChangePreview(patch, previous)
      expect(preview).toContain(retained)
      expect(preview).toContain(added)
      expect(JSON.stringify(preview)).not.toContain("sentinel-secret")
      expect(() => mcpSavePatch('{"timeout":0}', previous, { env: {}, headers: {} })).toThrow(
        timeout,
      )
    },
  )
  it("retains unknown editor data for correction rather than silently dropping it", () => {
    for (const text of ["[1]", "null", "{", '{"unknown":1}'])
      expect(() => parseMcpPatch(text)).toThrow()
    expect(parseMcpPatch('{"toolExposure":{"tool":"hidden"},"description":"text"}')).toEqual({
      toolExposure: { tool: "hidden" },
      description: "text",
    })
  })
  it("preserves omitted fields and maps, and masks field operations", () => {
    const patch = mcpSavePatch('{"description":"opaque-value"}', previous, {
      env: { NEW: "masked-replacement" },
      headers: {},
    })
    expect(patch).toEqual({
      description: "opaque-value",
      env: { OLD: null, REMOVE: null, NEW: "masked-replacement" },
    })
    const preview = mcpChangePreview(patch, previous)
    expect(preview).toContain("Preserved: command")
    expect(preview).toContain("Preserved: env.OLD")
    expect(preview).toContain("Added: env.NEW")
    expect(JSON.stringify(preview)).not.toMatch(/opaque-value|masked-replacement/)
  })
  it("distinguishes literal replacement, null preservation, omitted map keys, and clearing", () => {
    const patch = mcpSavePatch('{"env":{"OLD":null}}', previous, {
      env: { NEW: "replacement" },
      headers: {},
    })
    expect(patch.env).toEqual({ OLD: null, NEW: "replacement" })
    expect(mcpChangePreview(patch, previous)).toContain("Removed: env.REMOVE")
    expect(mcpChangePreview({ env: {} }, previous)).toEqual(
      expect.arrayContaining(["Removed: env.OLD", "Cleared: env map"]),
    )
    expect(mcpChangePreview({ env: { OLD: "replacement" } }, previous)).toContain(
      "Replaced: env.OLD",
    )
    expect(mcpChangePreview({}, previous)).toContain("Preserved: env.OLD")
  })
  it("never accepts literal secrets from advanced JSON or malformed maps", () => {
    for (const env of [null, [], "text", { TOKEN: "plaintext" }])
      expect(() =>
        mcpSavePatch(JSON.stringify({ env }), previous, { env: {}, headers: {} }),
      ).toThrow("masked")
  })
  it.each([
    {
      fields: ["command", "env"],
      patch: { headers: { X: "opaque-header" } },
      removed: "headers",
      kept: "command",
    },
    {
      fields: ["url", "headers"],
      patch: { env: { X: "opaque-env" } },
      removed: "env",
      kept: "url",
    },
  ])(
    "uses saved transport fields when the patch keeps $kept",
    ({ fields, patch, removed, kept }) => {
      const preview = mcpChangePreview(patch, { ...previous, fields })
      expect(preview).toContain(`Preserved: ${kept}`)
      expect(preview).toContain(`Removed by transport selection: ${removed}`)
      expect(preview.some((line) => line === `Added: ${removed}.X`)).toBe(false)
      expect(JSON.stringify(preview)).not.toContain("opaque-")
    },
  )
  it("reports transport cleanup instead of claiming removed fields are preserved", () => {
    const preview = mcpChangePreview({ url: "https://example.test/opaque" }, previous)
    expect(preview).toContain("Removed by transport selection: command")
    expect(preview).toContain("Removed by transport selection: env")
    expect(preview).not.toContain("Preserved: env.OLD")
    expect(JSON.stringify(preview)).not.toContain("opaque")
  })
})
