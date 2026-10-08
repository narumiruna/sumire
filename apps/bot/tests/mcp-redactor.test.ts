import { describe, expect, it } from "vitest"
import { createMcpRedactor, MCP_MAX_CREDENTIALS } from "../src/agent/mcp-redactor.js"

describe("bounded MCP redaction", () => {
  it("replaces longest literal matches in one pass, including punctuation and newlines", () => {
    const redact = createMcpRedactor(new Set(["a", "ab", "[x]", "x.y", "line\nbreak", "$token"]))
    expect(redact("ab a [x] x.y line\nbreak $token")).toBe(
      "[redacted] [redacted] [redacted] [redacted] [redacted] [redacted]",
    )
    expect(redact("ab")).toBe("[redacted]")
  })
  it("does not rescan replacement markers for later credentials", () => {
    expect(
      createMcpRedactor(new Set(["original-secret", "r", "e", "d", "a", "c", "t"]))(
        "original-secret",
      ),
    ).toBe("[redacted]")
  })
  it("accepts exactly the credential count and rejects one more", () => {
    const secrets = new Set(Array.from({ length: MCP_MAX_CREDENTIALS }, (_, i) => `private-${i}`))
    expect(createMcpRedactor(secrets)("private-127")).toBe("[redacted]")
    secrets.add("extra-secret")
    expect(() => createMcpRedactor(secrets)).toThrow("count")
  })
  it("enforces individual UTF-8 and aggregate byte bounds", () => {
    expect(createMcpRedactor(new Set(["é".repeat(2048)]))("é".repeat(2048))).toBe("[redacted]")
    expect(() => createMcpRedactor(new Set(["é".repeat(2049)]))).toThrow("byte limit")
    const secrets = new Set(Array.from({ length: 8 }, (_, i) => `${i}${"x".repeat(4095)}`))
    expect(() => createMcpRedactor(secrets)).not.toThrow()
    secrets.add("extra")
    expect(() => createMcpRedactor(secrets)).toThrow("total byte limit")
  })
  it("leaves input unchanged when no nonempty credentials exist", () => {
    expect(createMcpRedactor(new Set([""]))("text")).toBe("text")
  })
})
