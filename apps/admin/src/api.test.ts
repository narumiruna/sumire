import { initialPolicy } from "@narumitw/sumire-policy"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError, parseIds, parseSnapshot, request } from "./api.js"

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

describe("settings snapshot validation", () => {
  const snapshot = () => ({
    revision: 2,
    applied: 1,
    epoch: 2,
    status: "pending",
    policy: initialPolicy(),
  })
  it("retains verified metadata and returns a parsed policy without input aliases", () => {
    const original = snapshot()
    const parsed = parseSnapshot(original)
    expect(parsed).toEqual(original)
    parsed.policy.privateUsers.push(42)
    expect(original.policy.privateUsers).toEqual([])
  })
  it.each([undefined, null, {}, [], "settings"])("rejects an invalid response %j", (value) => {
    expect(() => parseSnapshot(value)).toThrow("Could not verify saved settings")
  })
  it.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2"])(
    "rejects an invalid revision %j",
    (revision) => {
      expect(() => parseSnapshot({ ...snapshot(), revision })).toThrow(
        "Could not verify saved settings",
      )
    },
  )
  it.each([undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"])(
    "rejects an invalid applied revision %j",
    (applied) => {
      expect(() => parseSnapshot({ ...snapshot(), applied })).toThrow(
        "Could not verify saved settings",
      )
    },
  )
  it.each([undefined, null, "", 1])("rejects an invalid application status %j", (status) => {
    expect(() => parseSnapshot({ ...snapshot(), status })).toThrow(
      "Could not verify saved settings",
    )
  })
  it("rejects an invalid policy", () => {
    expect(() => parseSnapshot({ ...snapshot(), policy: {} })).toThrow()
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
