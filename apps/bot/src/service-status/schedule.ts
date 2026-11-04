import { createHash } from "node:crypto"
import type { StatusQuietHours, StatusSubscription } from "@narumitw/sumire-policy"

// Node.js 26 supplies Temporal. These types cover only the operations used below.
interface LocalDate {
  add(duration: { days: number }): LocalDate
  toPlainDateTime(time: string): {
    toZonedDateTime(
      timeZone: string,
      options: { disambiguation: "compatible" },
    ): { epochMilliseconds: number }
  }
}

const { Temporal } = globalThis as unknown as {
  Temporal: {
    Instant: {
      fromEpochMilliseconds(value: number): {
        toZonedDateTimeISO(timeZone: string): { toPlainDate(): LocalDate }
      }
    }
  }
}

/**
 * Return the UTC end of the daily [start, end) window that contains now.
 * Temporal-compatible boundaries use the earlier repeated time and shift a missing time forward
 * by the offset gap. Compare instants so a repeated hour cannot reopen an ended window.
 * Quiet-hour fields must have passed the policy schema.
 */
export function quietUntil(quiet: StatusQuietHours | null, now: number): number | null {
  if (!Number.isSafeInteger(now) || Math.abs(now) > 8_640_000_000_000_000)
    throw new RangeError("Status scheduling requires a finite, in-range integer timestamp")
  if (quiet === null) return null
  const today = Temporal.Instant.fromEpochMilliseconds(now)
    .toZonedDateTimeISO(quiet.timeZone)
    .toPlainDate()
  for (const days of [-1, 0]) {
    const date = today.add({ days })
    const endDate = quiet.start > quiet.end ? date.add({ days: 1 }) : date
    const start = date
      .toPlainDateTime(quiet.start)
      .toZonedDateTime(quiet.timeZone, { disambiguation: "compatible" }).epochMilliseconds
    const end = endDate
      .toPlainDateTime(quiet.end)
      .toZonedDateTime(quiet.timeZone, { disambiguation: "compatible" }).epochMilliseconds
    if (now >= start && now < end) return end
  }
  return null
}

/** Hash resolved rules, not policy revisions. Array and object order do not change a rule. */
export function statusRuleFingerprint(subscription: StatusSubscription): string {
  const componentSelections = Object.fromEntries(
    Object.entries(subscription.componentSelections)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([provider, ids]) => [provider, ids === null ? null : [...ids].sort()]),
  )
  const quiet = subscription.quietHours
  return createHash("sha256")
    .update(
      JSON.stringify({
        chatId: subscription.chatId,
        providers: [...subscription.providers].sort(),
        minimumImpact: subscription.minimumImpact,
        componentSelections,
        quietHours:
          quiet === null ? null : { timeZone: quiet.timeZone, start: quiet.start, end: quiet.end },
        batchWindowSeconds: subscription.batchWindowSeconds,
        notifyUpdates: subscription.notifyUpdates,
        notifyResolved: subscription.notifyResolved,
        includeMaintenance: subscription.includeMaintenance,
      }),
    )
    .digest("hex")
}
