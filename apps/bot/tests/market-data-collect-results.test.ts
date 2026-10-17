import { describe, expect, it } from "vitest"
import { collectMarketResults } from "../src/market-data/collect-results.js"

describe("collectMarketResults", () => {
  it("retains nonempty results in input order despite failures and completion order", async () => {
    let resolveFirst!: (value: string) => void
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve
    })
    const settled = Promise.allSettled([
      first,
      Promise.resolve(""),
      Promise.reject(new Error("Unavailable")),
      Promise.resolve(undefined),
      Promise.resolve("second"),
    ])
    resolveFirst("first")

    expect(collectMarketResults(await settled)).toEqual(["first", "second"])
  })

  it("retains structured rate objects by identity", () => {
    const rate = { base: "USD", date: "2026-01-02", quote: "JPY", rate: 150 }
    const results = collectMarketResults([
      { status: "rejected", reason: new Error("Unavailable") },
      { status: "fulfilled", value: rate },
    ])

    expect(results).toHaveLength(1)
    expect(results[0]).toBe(rate)
  })

  it.each([new Error("First failure"), "First failure", undefined, null])(
    "throws the first rejection reason unchanged when no data exists: %s",
    async (reason) => {
      await expect(
        Promise.resolve().then(() =>
          collectMarketResults([
            { status: "fulfilled", value: undefined },
            { status: "rejected", reason },
            { status: "fulfilled", value: "" },
            { status: "rejected", reason: new Error("Second failure") },
          ]),
        ),
      ).rejects.toBe(reason)
    },
  )

  it("returns no data when all fulfilled results are empty", () => {
    expect(
      collectMarketResults([
        { status: "fulfilled", value: "" },
        { status: "fulfilled", value: undefined },
      ]),
    ).toEqual([])
  })

  it("returns no data for an empty batch", () => {
    expect(collectMarketResults([])).toEqual([])
  })
})
