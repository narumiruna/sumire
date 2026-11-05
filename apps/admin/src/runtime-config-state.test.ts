import type { RuntimeConfigResponse } from "@narumitw/sumire-contracts"
import { afterEach, describe, expect, it } from "vitest"
import { errorMessage, LocalizedError, setLocale } from "./i18n.js"
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

afterEach(() => setLocale("en"))

describe("runtime management metadata", () => {
  it.each([
    ["zh-TW", "此名稱保留給主機設定使用。", "請輸入有效的已儲存名稱。"],
    [
      "ja",
      "この名前はホスト設定用に予約されています。",
      "有効な保存済みの名前を入力してください。",
    ],
  ] as const)(
    "localizes %s validation while preserving metadata and references",
    (locale, reserved, reference) => {
      setLocale(locale)
      expect(runtimeValueError("ADMIN_PORT", "variable", "x")).toBe(reserved)
      expect(() => storedReference("bad-name")).toThrow(reference)
      expect(storedReference("TOKEN", "Bearer ")).toBe(`Bearer \${TOKEN}`)
      expect(parseRuntimeConfig(response)).toEqual(response)
    },
  )
  it.each([
    [
      { ...response, revision: 0 },
      "Could not verify runtime configuration.",
      "無法驗證執行階段設定。",
      "ランタイム設定を確認できません。",
    ],
    [
      { ...response, entries: [{ ...response.entries[0], name: "invalid-name" }] },
      "Invalid entry metadata.",
      "項目中繼資料無效。",
      "項目のメタデータが無効です。",
    ],
    [
      { ...response, entries: [{ ...response.entries[0], kind: "other" }] },
      "Invalid entry metadata.",
      "項目中繼資料無效。",
      "項目のメタデータが無効です。",
    ],
  ] as const)(
    "retains a message key for invalid metadata %j",
    (value, english, chinese, japanese) => {
      let retained: unknown
      try {
        parseRuntimeConfig(value as RuntimeConfigResponse)
      } catch (error) {
        retained = error
      }
      expect(retained).toBeInstanceOf(LocalizedError)
      if (!(retained instanceof LocalizedError)) throw new Error("Expected a localized error")
      expect(errorMessage(retained)).toBe(english)
      setLocale("zh-TW")
      expect(errorMessage(retained)).toBe(chinese)
      setLocale("ja")
      expect(errorMessage(retained)).toBe(japanese)
    },
  )

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
      "ENCRYPTION_KEY",
    ])
      expect(runtimeValueError(name, "variable", "x")).not.toBe("")
  })
  it("uses explicit stored references, not decrypted copies or ambient names", () => {
    expect(storedReference("TOKEN", "Bearer ")).toBe(`Bearer \${TOKEN}`)
    expect(storedReference("PUBLIC")).toBe(`\${PUBLIC}`)
    expect(() => storedReference("bad-name")).toThrow()
  })
})
