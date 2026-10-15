import { createPublicUrlLoader } from "@narumitw/sumire-url-tool"
import type { Settings } from "./config/settings.js"

/** Keep article preloading and Pi URL tools on the same source selection and limits. */
export function createBotUrlLoader(settings: Settings) {
  return createPublicUrlLoader({
    allowedSchemes: settings.botUrlAllowedSchemes,
    maxChars: settings.botUrlMaxExtractedChars,
    timeoutMs: Math.round(settings.botUrlTimeoutSeconds * 1_000),
    urlContentTimeoutSeconds: settings.botUrlContentTimeoutSeconds,
    firecrawlFallback: true,
  })
}
