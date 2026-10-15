import { describe, expect, it, vi } from "vitest"
import { captureSetupLink } from "./passkey.js"

describe("passkey setup fragments", () => {
  it("captures the secret once and removes it from the browser URL", () => {
    const secret = "s".repeat(43)
    const replaceState = vi.fn()
    expect(
      captureSetupLink(
        { hash: `#setup=${secret}`, pathname: "/", search: "" } as Location,
        { replaceState } as unknown as History,
      ),
    ).toBe(secret)
    expect(replaceState).toHaveBeenCalledWith(null, "", "/")
  })
  it("rejects invalid fragments and preserves the non-secret path and query", () => {
    const replaceState = vi.fn()
    expect(
      captureSetupLink(
        { hash: "#setup=invalid", pathname: "/", search: "?view=login" } as Location,
        { replaceState } as unknown as History,
      ),
    ).toBe("")
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?view=login")
  })
})
