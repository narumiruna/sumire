import { createPublicUrlLoader, type PublicUrlLoader } from "@narumitw/sumire-pi-url-reader"
import type { RuntimeConfigReader } from "@narumitw/sumire-runtime-config"
import type { Settings } from "./config/settings.js"

/** Keep article preloading and Pi URL tools on the same source selection and limits. */
export function createBotUrlLoader(
  settings: Settings,
  runtime?: RuntimeConfigReader,
): PublicUrlLoader {
  const loader = createPublicUrlLoader({
    allowedSchemes: settings.botUrlAllowedSchemes,
    maxChars: settings.botUrlMaxExtractedChars,
    timeoutMs: Math.round(settings.botUrlTimeoutSeconds * 1_000),
    urlContentTimeoutSeconds: settings.botUrlContentTimeoutSeconds,
    firecrawlFallback: true,
  })
  return {
    load(url, options) {
      return loader.load(url, {
        ...options,
        firecrawlApiKey: runtime?.readSecret("FIRECRAWL_API_KEY") ?? null,
      })
    },
  }
}
