export const GITHUB_NOTIFICATIONS_TOOL = "read_github_notifications"
/** The host supplies a verified private-chat ID and validated policy, never model arguments. */
export function allowsNotificationChat(chatId: number, allowedUserIds: readonly number[]): boolean {
  return Number.isSafeInteger(chatId) && chatId > 0 && allowedUserIds.includes(chatId)
}
