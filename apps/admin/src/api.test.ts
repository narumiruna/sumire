import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, parseIds, request } from "./api.js"

afterEach(() => vi.unstubAllGlobals())

describe("cancellable API reads", () => {
  it("passes the abort signal without changing GET credentials", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ state: "loaded" }) })
    vi.stubGlobal("fetch", fetch)
    const controller = new AbortController()
    await expect(
      request(
        "chats/42/durable?view=conversations",
        undefined,
        undefined,
        "GET",
        controller.signal,
      ),
    ).resolves.toEqual({ state: "loaded" })
    expect(fetch).toHaveBeenCalledWith("/api/chats/42/durable?view=conversations", {
      credentials: "same-origin",
      signal: controller.signal,
    })
  })
  it("keeps authentication failures structured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: "Session expired" }),
      }),
    )
    await expect(request("chats/42/durable?view=conversations")).rejects.toEqual(
      new ApiError(401, "Session expired"),
    )
  })
})

describe("Telegram access IDs", () => {
  it("normalizes explicit private-user and group lists independently", () => {
    expect(parseIds("42, 43 42", true)).toEqual([42, 43])
    expect(parseIds("-100,-200", false)).toEqual([-100, -200])
    expect(parseIds("", true)).toEqual([])
  })
  it.each(["0", "-100", "1.5", "9007199254740992", "x"])("rejects invalid private ID %s", (value) =>
    expect(() => parseIds(value, true)).toThrow(),
  )
  it("rejects positive group IDs", () => expect(() => parseIds("42", false)).toThrow())
})
