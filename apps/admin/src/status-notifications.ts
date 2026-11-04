import type { StatusNotifications } from "@narumitw/sumire-policy"

export const statusProviderNames = {
  github: "GitHub",
  openai: "OpenAI",
  claude: "Claude",
  cloudflare: "Cloudflare",
} satisfies Record<StatusNotifications["providers"][number], string>

/** Require the exact signed decimal ID; do not normalize URLs, spaces, or leading zeros. */
export function statusChatIdError(value: string, chatIds: readonly number[]): string {
  if (
    !/^-?[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    String(Number(value)) !== value
  )
    return "Enter a canonical, non-zero Telegram chat ID: a safe integer with an optional minus sign, without spaces or leading zeros."
  if (chatIds.includes(Number(value))) return "This Telegram chat ID is already selected."
  if (chatIds.length >= 1000)
    return "Remove a destination before adding another. The limit is 1,000 destinations."
  return ""
}

export function statusPollingIntervals(seconds: number): number[] {
  return [...new Set([60, 120, 300, 600, 900, 1800, 3600, seconds])].sort((a, b) => a - b)
}
