import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createUrlTool, normalizeUrlFailure } from "@narumitw/sumire-pi-url-reader"
import { resolveExplicitLoadChain } from "@narumitw/sumire-url-reader"
import { runCommand, YouTubeLoader, YtdlpLoader } from "@narumitw/sumire-url-reader/loaders"
import { formatArticleSourceFailure } from "../dist/blog-post/source-failure.js"

// Run in the production image with networking disabled. No bot session or model is started.
const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
const originalFetch = globalThis.fetch
let hasCaptions = true
const directory = await mkdtemp(join(tmpdir(), "sumire-url-diagnostics-check-"))
try {
  globalThis.fetch = async (target) => {
    const captions = hasCaptions
      ? {
          playerCaptionsTracklistRenderer: {
            captionTracks: [
              { languageCode: "en", baseUrl: "https://www.youtube.com/api/timedtext" },
            ],
          },
        }
      : undefined
    if (String(target).includes("/youtubei/")) return Response.json({ captions })
    if (String(target).includes("/api/timedtext"))
      return new Response('<transcript><text start="0" dur="1">offline caption</text></transcript>')
    return new Response(
      `var ytInitialPlayerResponse = ${JSON.stringify({ playabilityStatus: { status: "OK" }, captions })};`,
    )
  }
  assert.equal(await new YouTubeLoader(["en"]).load(url), "offline caption")

  const metadataPath = join(directory, "video.json")
  await writeFile(
    metadataPath,
    JSON.stringify({
      id: "offline",
      title: "Offline fixture",
      duration: 5_198,
      formats: [
        {
          format_id: "audio",
          url: "https://example.com/audio.m4a",
          ext: "m4a",
          acodec: "mp4a.40.2",
          vcodec: "none",
        },
      ],
    }),
  )
  const fallback = new YtdlpLoader({
    commandRunner: async (command, args, signal) => {
      assert.equal(command, "yt-dlp")
      assert.ok(args.includes("--skip-download"), "Over-limit media must not be downloaded")
      // Supply local metadata to the real installed yt-dlp without extracting another URL.
      return runCommand(command, [...args.slice(0, -1), "--load-info-json", metadataPath], signal)
    },
  })
  hasCaptions = false
  const chain = () =>
    resolveExplicitLoadChain(url, ["youtube", "youtube-ytdlp"], {
      getFactory: (name) => () => (name === "youtube" ? new YouTubeLoader(["en"]) : fallback),
    })
  const error = await chain()
    .loadDetailed()
    .then(
      () => {
        throw new Error("Expected failure")
      },
      (failure) => failure,
    )
  const failure = normalizeUrlFailure(error, url)
  assert.equal(failure.code, "media_duration_limit")
  assert.deepEqual(
    failure.attempts.map((attempt) => attempt.diagnostic?.code),
    ["captions_unavailable", "media_duration_limit"],
  )
  assert.equal(
    formatArticleSourceFailure(failure, 1),
    "無法載入第 1 個來源：未取得可用字幕；音訊轉錄備援僅支援 1 小時內的影片，這支影片長 1 小時 26 分 38 秒。請提供逐字稿或較短的來源。",
  )
  const result = await createUrlTool({
    load: async () => {
      throw error
    },
  }).execute("offline", { url }, undefined, undefined, undefined)
  assert.equal(result.isError, true)
  assert.deepEqual(result.details, failure)
  assert.ok(!JSON.stringify(result).includes(url))
  await runCommand("whisper", ["--help"])
  console.log(
    "Offline URL checks passed: captions, real yt-dlp metadata, duration rejection, Telegram message, Pi error result, Whisper CLI",
  )
} finally {
  globalThis.fetch = originalFetch
  await rm(directory, { recursive: true, force: true })
}
