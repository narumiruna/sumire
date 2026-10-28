export interface FirecrawlCredentialOptions {
  /** undefined uses the environment; null disables environment fallback. */
  firecrawlApiKey?: string | null
}

export function resolveFirecrawlApiKey(value?: string | null): string | null {
  return value === undefined ? (process.env.FIRECRAWL_API_KEY ?? null) : value
}

export function redactFirecrawlCredential(value: string, apiKey: string): string {
  return value.split(apiKey).join("[REDACTED]")
}
