export const GITHUB_NOTIFICATIONS_TOOL = "read_github_notifications"
export const GITHUB_NOTIFICATIONS_TOKEN = "GITHUB_NOTIFICATIONS_TOKEN"
export const GITHUB_NOTIFICATIONS_USERS = "GITHUB_NOTIFICATIONS_ALLOWED_USER_IDS"

/** Strict JSON array of positive Telegram user IDs. Empty means deny everyone. */
export function parseAllowedUserIds(value: string): number[] {
  let ids: unknown
  try {
    ids = JSON.parse(value)
  } catch {
    throw new Error("GitHub notifications allowlist must be a JSON array of positive user IDs")
  }
  if (
    !Array.isArray(ids) ||
    ids.length > 1000 ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    new Set(ids).size !== ids.length
  )
    throw new Error("GitHub notifications allowlist must contain unique positive user IDs")
  return ids as number[]
}

/** The host supplies a verified private-chat ID, never model arguments or message text. */
export function allowsNotificationChat(chatId: number, value?: string): boolean {
  if (!Number.isSafeInteger(chatId) || chatId <= 0 || value === undefined) return false
  try {
    return parseAllowedUserIds(value).includes(chatId)
  } catch {
    return false
  }
}
