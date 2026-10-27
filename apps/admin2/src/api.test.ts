import { initialPolicy } from "@narumitw/sumire-policy"
import { describe, expect, it } from "vitest"
import { ApiError, errorMessage, parseSnapshot } from "./api.js"

describe("settings responses", () => {
  const valid = { revision: 3, applied: 3, status: "applied", epoch: 1, policy: initialPolicy() }
  it("accepts a verified snapshot", () => {
    expect(parseSnapshot(valid).revision).toBe(3)
  })
  it("reports an unreadable policy in words, never as schema output", () => {
    const broken = { ...valid, policy: { ...initialPolicy(), providers: [{ id: "x" }] } }
    expect(() => parseSnapshot(broken)).toThrow(/not in a shape this console understands/)
  })
  it("rejects a snapshot without a usable revision", () => {
    expect(() => parseSnapshot({ ...valid, revision: 0 })).toThrow(/Reload/)
  })
  it("explains revision conflicts and expired sessions", () => {
    expect(errorMessage(new ApiError(409, "Revision conflict"))).toMatch(/changed since/)
    expect(errorMessage(new ApiError(401, "Sign in with a passkey"))).toMatch(/Sign in again/)
  })
})
