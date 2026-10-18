import { type FailureCode, FailureDiagnosticError } from "../core/errors.js"
import type { Loader } from "../core/loader.js"
import { parseYouTubeVideoTarget, requireLoaderApplicability } from "../sources/applicability.js"

export const DEFAULT_LANGUAGES = [
  "zh-TW",
  "zh-Hant",
  "zh",
  "zh-Hans",
  "ja",
  "ko",
  "en",
  "fr",
  "de",
  "es",
  "it",
  "pt",
  "pt-BR",
  "nl",
  "sv",
  "pl",
  "th",
  "vi",
  "id",
  "ms",
  "fil",
  "ru",
  "ar",
  "hi",
] as const

export function parseVideoId(url: string): string {
  return parseYouTubeVideoTarget(url).videoId
}

export class YouTubeLoader implements Loader {
  constructor(private readonly languages: readonly string[] = DEFAULT_LANGUAGES) {}

  async load(url: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    const videoId = requireLoaderApplicability(
      "YouTubeLoader",
      url,
      parseYouTubeVideoTarget,
    ).videoId
    const {
      fetchTranscript,
      YoutubeTranscriptDisabledError,
      YoutubeTranscriptNotAvailableLanguageError,
    } = await import("youtube-transcript")
    let code: FailureCode = "caption_extraction_failed"
    for (const language of [...this.languages, undefined]) {
      signal?.throwIfAborted()
      try {
        const snippets = await fetchTranscript(videoId, language ? { lang: language } : undefined)
        signal?.throwIfAborted()
        const result = snippets
          .map((snippet) => snippet.text.trim())
          .filter(Boolean)
          .join("\n")
        if (result) return result
        code = "captions_empty"
      } catch (error) {
        signal?.throwIfAborted()
        // DisabledError is also used when no caption tracks were obtained. It does not
        // establish an author setting. NotAvailableError includes ambiguous HTTP failures.
        code =
          error instanceof YoutubeTranscriptDisabledError
            ? "captions_unavailable"
            : error instanceof YoutubeTranscriptNotAvailableLanguageError
              ? "caption_language_unavailable"
              : "caption_extraction_failed"
      }
    }
    throw new FailureDiagnosticError("YouTubeLoader", url, { code, phase: "captions" })
  }
}

export { YouTubeLoader as YoutubeLoader }
