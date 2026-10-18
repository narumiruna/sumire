import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptNotAvailableLanguageError,
  YoutubeTranscriptTooManyRequestError,
  YoutubeTranscriptVideoUnavailableError,
} from "youtube-transcript"

import { FailureDiagnosticError } from "../src/core/errors.js"

import { YouTubeLoader } from "../src/loaders/youtube.js"

const mocks = vi.hoisted(() => ({ fetchTranscript: vi.fn() }))

vi.mock("youtube-transcript", async (importOriginal) => ({
  ...(await importOriginal<typeof import("youtube-transcript")>()),
  fetchTranscript: mocks.fetchTranscript,
}))

describe("YouTube loader transcript selection", () => {
  beforeEach(() => {
    mocks.fetchTranscript.mockReset()
  })

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

  it.each([
    [new YoutubeTranscriptDisabledError("fixture"), "captions_unavailable"],
    [
      new YoutubeTranscriptNotAvailableLanguageError("en", ["fr"], "fixture"),
      "caption_language_unavailable",
    ],
    [new YoutubeTranscriptNotAvailableError("fixture"), "caption_extraction_failed"],
    [new YoutubeTranscriptTooManyRequestError(), "caption_extraction_failed"],
    [new YoutubeTranscriptVideoUnavailableError("fixture"), "caption_extraction_failed"],
    [new Error("Transcript is disabled; HTTP 403; secret token"), "caption_extraction_failed"],
    [
      Object.assign(new Error("secret"), { name: "YoutubeTranscriptDisabledError" }),
      "caption_extraction_failed",
    ],
  ])(
    "classifies caption exception classes without matching text (fixture %#)",
    async (upstream, code) => {
      mocks.fetchTranscript.mockRejectedValue(upstream)
      const error = await new YouTubeLoader(["en"])
        .load("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        .catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(FailureDiagnosticError)
      expect(error).toMatchObject({ diagnostic: { code, phase: "captions" } })
      expect(String(error)).not.toMatch(/secret|fixture|HTTP|disabled/u)
    },
  )

  it.each([{ snippets: [] }, { snippets: [{ text: " " }] }])(
    "reports empty caption output (fixture %#)",
    async ({ snippets }) => {
      mocks.fetchTranscript.mockResolvedValue(snippets)
      await expect(
        new YouTubeLoader(["en"]).load("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
      ).rejects.toMatchObject({ diagnostic: { code: "captions_empty", phase: "captions" } })
    },
  )

  it("tries the upstream default track after requested languages fail", async () => {
    mocks.fetchTranscript
      .mockRejectedValueOnce(
        new YoutubeTranscriptNotAvailableLanguageError("en", ["fr"], "fixture"),
      )
      .mockResolvedValueOnce([{ text: "Default transcript" }])
    await expect(
      new YouTubeLoader(["en"]).load("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ).resolves.toBe("Default transcript")
    expect(mocks.fetchTranscript).toHaveBeenLastCalledWith("dQw4w9WgXcQ", undefined)
  })

  it("does not carry a language mismatch into a later ambiguous extraction failure", async () => {
    mocks.fetchTranscript
      .mockRejectedValueOnce(
        new YoutubeTranscriptNotAvailableLanguageError("en", ["fr"], "fixture"),
      )
      .mockRejectedValueOnce(new Error("unknown"))
    await expect(
      new YouTubeLoader(["en"]).load("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
    ).rejects.toMatchObject({
      diagnostic: { code: "caption_extraction_failed", phase: "captions" },
    })
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
