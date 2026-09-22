import { beforeEach, describe, expect, it, vi } from "vitest"

import { YouTubeLoader } from "../src/loaders/youtube.js"

const mocks = vi.hoisted(() => ({ fetchTranscript: vi.fn() }))

vi.mock("youtube-transcript", () => ({ fetchTranscript: mocks.fetchTranscript }))

describe("YouTube loader transcript selection", () => {
  beforeEach(() => mocks.fetchTranscript.mockReset())

  it("tries preferred languages in order", async () => {
    mocks.fetchTranscript
      .mockRejectedValueOnce(new Error("zh-TW unavailable"))
      .mockResolvedValueOnce([{ text: "English transcript" }])

    await expect(
      new YouTubeLoader(["zh-TW", "en"]).load("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ).resolves.toBe("English transcript")
    expect(mocks.fetchTranscript).toHaveBeenNthCalledWith(1, "dQw4w9WgXcQ", {
      lang: "zh-TW",
    })
    expect(mocks.fetchTranscript).toHaveBeenNthCalledWith(2, "dQw4w9WgXcQ", { lang: "en" })
  })

  it("stops language attempts after cancellation", async () => {
    let finishAttempt: ((value: Array<{ text: string }>) => void) | undefined
    mocks.fetchTranscript.mockImplementationOnce(
      () =>
        new Promise<Array<{ text: string }>>((resolve) => {
          finishAttempt = resolve
        }),
    )
    const controller = new AbortController()
    const loading = new YouTubeLoader(["en", "fr"]).load(
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      controller.signal,
    )
    await vi.waitFor(() => expect(mocks.fetchTranscript).toHaveBeenCalledOnce())

    controller.abort(new Error("cancelled"))
    finishAttempt?.([{ text: "stale transcript" }])

    await expect(loading).rejects.toThrow("cancelled")
    expect(mocks.fetchTranscript).toHaveBeenCalledOnce()
  })
})
