import { describe, expect, it, vi } from "vitest"
import { captureAccessLink, clearAccessLink, tabStorage } from "./access-link.js"

function fixture(hash = "") {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  } as Storage
  const location = { hash, pathname: "/", search: "?view=access" } as Location
  const history = { replaceState: vi.fn() } as unknown as History
  return { storage, location, history, values }
}
describe("chat access intent", () => {
  it("removes the fragment before requests and restores valid intent through tab reload", () => {
    const token = "a".repeat(64)
    const f = fixture(`#allow=${token}`)
    expect(captureAccessLink(f.location, f.history, f.storage, 1000)).toBe(token)
    expect(f.history.replaceState).toHaveBeenCalledWith(null, "", "/?view=access")
    f.location.hash = ""
    expect(captureAccessLink(f.location, f.history, f.storage, 2000)).toBe(token)
    expect(captureAccessLink(f.location, f.history, f.storage, 901000)).toBe("")
    expect(f.values.size).toBe(0)
  })
  it("clears malformed links, expired intent, and logout intent", () => {
    const f = fixture(`#allow=${"a".repeat(64)}`)
    captureAccessLink(f.location, f.history, f.storage, 1000)
    f.location.hash = "#allow=invalid"
    expect(captureAccessLink(f.location, f.history, f.storage, 2000)).toBe("")
    expect(f.values.size).toBe(0)
    f.location.hash = `#allow=${"b".repeat(64)}`
    captureAccessLink(f.location, f.history, f.storage, 2000)
    clearAccessLink(f.storage)
    f.location.hash = ""
    expect(captureAccessLink(f.location, f.history, f.storage, 3000)).toBe("")
    f.values.set("sumire.pending-chat-access", "not-json")
    expect(captureAccessLink(f.location, f.history, f.storage)).toBe("")
  })
  it("leaves setup fragments for the existing setup capture and handles blocked storage", () => {
    const f = fixture("#setup=fixture")
    expect(captureAccessLink(f.location, f.history, f.storage)).toBe("")
    expect(f.history.replaceState).not.toHaveBeenCalled()
    expect(
      tabStorage({
        get sessionStorage(): Storage {
          throw new Error("blocked")
        },
      }),
    ).toBeUndefined()
    expect(tabStorage({ sessionStorage: f.storage })).toBe(f.storage)
    const blocked = {
      getItem: () => {
        throw new Error("blocked")
      },
      setItem: () => {
        throw new Error("blocked")
      },
      removeItem: () => {
        throw new Error("blocked")
      },
    } as unknown as Storage
    f.location.hash = `#allow=${"a".repeat(64)}`
    expect(captureAccessLink(f.location, f.history, blocked)).toBe("a".repeat(64))
    f.location.hash = ""
    expect(captureAccessLink(f.location, f.history, blocked)).toBe("")
  })
})
