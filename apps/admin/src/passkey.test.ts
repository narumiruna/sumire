import { describe, expect, it, vi } from "vitest"
import { captureSetupLink } from "./passkey.js"

describe("passkey setup fragments", () => {
  it("leaves non-setup navigation fragments unchanged", () => {
    for (const hash of ["#model-availability", "#default-tool-permissions", "#unrelated"]) {
      const replaceState = vi.fn()
      expect(
        captureSetupLink(
          { hash, pathname: "/", search: "?section=Model+Providers" } as Location,
          { replaceState } as unknown as History,
        ),
      ).toBe("")
      expect(replaceState).not.toHaveBeenCalled()
    }
  })
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
