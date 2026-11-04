import type {
  StatusChatOverride,
  StatusNotifications,
  StatusQuietHours,
} from "@narumitw/sumire-policy"

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

/** Removal revokes the subscription and its overrides together. It never changes Pi access. */
export function removeStatusDestination(settings: StatusNotifications, chatId: number) {
  const chatOverrides = { ...settings.chatOverrides }
  delete chatOverrides[String(chatId)]
  return { ...settings, chatIds: settings.chatIds.filter((id) => id !== chatId), chatOverrides }
}

/** Undefined restores inheritance; explicit null and empty lists remain explicit. */
export function withStatusOverride<K extends keyof StatusChatOverride>(
  settings: StatusNotifications,
  chatId: number,
  key: K,
  value: StatusChatOverride[K],
): StatusNotifications {
  if (!settings.chatIds.includes(chatId)) return settings
  const override = { ...settings.chatOverrides[String(chatId)] }
  if (value === undefined) delete override[key]
  else override[key] = value
  if (override.componentSelections && !Object.keys(override.componentSelections).length)
    delete override.componentSelections
  const chatOverrides = { ...settings.chatOverrides }
  if (Object.keys(override).length) chatOverrides[String(chatId)] = override
  else delete chatOverrides[String(chatId)]
  return { ...settings, chatOverrides }
}

export function statusSelectionError(settings: StatusNotifications): string {
  let count = 0
  for (const selections of [
    settings.componentSelections,
    ...Object.values(settings.chatOverrides).map((override) => override.componentSelections),
  ]) {
    for (const ids of Object.values(selections ?? {})) {
      if ((ids?.length ?? 0) > 128)
        return "Remove a component or group before adding another. Each service selection allows at most 128 IDs."
      count += ids?.length ?? 0
    }
  }
  return count > 512
    ? "Remove component or group selections from shared defaults or chat overrides. Status settings allow at most 512 IDs in total."
    : ""
}

export function statusQuietHoursError(hours: StatusQuietHours): string {
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d(?![\s\S])/
  if (!time.test(hours.start) || !time.test(hours.end))
    return "Enter complete start and end times in HH:mm format, from 00:00 to 23:59."
  if (hours.start === hours.end)
    return "Choose different start and end times for the daily quiet window."
  if (!hours.timeZone || hours.timeZone.length > 128 || /^[+-]/.test(hours.timeZone))
    return "Enter an explicit IANA time zone, for example Asia/Taipei."
  try {
    new Intl.DateTimeFormat("en", { timeZone: hours.timeZone })
    return ""
  } catch {
    return "Enter an explicit IANA time zone, for example Asia/Taipei."
  }
}
