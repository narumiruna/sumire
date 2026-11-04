import {
  initialStatusNotifications,
  resolveStatusSubscription,
  type StatusQuietHours,
  type StatusSubscription,
  statusNotificationsSchema,
} from "@narumitw/sumire-policy"
import { afterEach, describe, expect, it, vi } from "vitest"
import { quietUntil, statusRuleFingerprint } from "../src/service-status/schedule.js"

function quiet(timeZone = "Asia/Taipei", start = "22:00", end = "07:00"): StatusQuietHours {
  return { timeZone, start, end }
}

function subscription(overrides: Partial<StatusSubscription> = {}): StatusSubscription {
  return {
    chatId: 101,
    providers: ["github", "openai"],
    minimumImpact: "major",
    componentSelections: { github: ["api", "web"], openai: null, claude: [], cloudflare: ["edge"] },
    quietHours: quiet(),
    batchWindowSeconds: 300,
    notifyUpdates: true,
    notifyResolved: true,
    includeMaintenance: false,
    ...overrides,
  }
}

function until(rule: StatusQuietHours | null, timestamp: string): string | null {
  const end = quietUntil(rule, Date.parse(timestamp))
  return end === null ? null : new Date(end).toISOString()
}

afterEach(() => vi.unstubAllEnvs())

describe("service status daily quiet windows", () => {
  it("returns no boundary when quiet hours are off", () => {
    expect(quietUntil(null, Date.parse("2030-01-01T15:00:00Z"))).toBeNull()
  })

  it.each([
    { now: "2030-01-01T13:59:59.999Z", end: null },
    { now: "2030-01-01T14:00:00Z", end: "2030-01-01T23:00:00.000Z" },
    { now: "2030-01-01T16:00:00Z", end: "2030-01-01T23:00:00.000Z" },
    { now: "2030-01-01T22:59:59.999Z", end: "2030-01-01T23:00:00.000Z" },
    { now: "2030-01-01T23:00:00Z", end: null },
    { now: "2030-01-02T03:00:00Z", end: null },
  ])(
    "uses an inclusive start and exclusive end in overnight Taipei time at $now",
    ({ now, end }) => {
      expect(until(quiet(), now)).toBe(end)
    },
  )

  it.each([
    { now: "2030-01-01T00:59:59.999Z", end: null },
    { now: "2030-01-01T01:00:00Z", end: "2030-01-01T09:00:00.000Z" },
    { now: "2030-01-01T08:59:59.999Z", end: "2030-01-01T09:00:00.000Z" },
    { now: "2030-01-01T09:00:00Z", end: null },
  ])("handles same-day Taipei hours at $now", ({ now, end }) => {
    expect(until(quiet("Asia/Taipei", "09:00", "17:00"), now)).toBe(end)
  })

  it("crosses year boundaries without using the host date", () => {
    expect(until(quiet("UTC"), "2030-12-31T23:59:59Z")).toBe("2031-01-01T07:00:00.000Z")
  })

  it("handles fractional-hour UTC offsets", () => {
    expect(until(quiet("Asia/Kathmandu"), "2030-01-01T16:15:00Z")).toBe("2030-01-02T01:15:00.000Z")
  })

  it("does not depend on the host time zone", () => {
    for (const timeZone of ["UTC", "Pacific/Honolulu", "Europe/Berlin"]) {
      vi.stubEnv("TZ", timeZone)
      expect(until(quiet(), "2030-01-01T14:00:00Z")).toBe("2030-01-01T23:00:00.000Z")
    }
  })

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0.5,
    8_640_000_000_000_001,
    -8_640_000_000_000_001,
  ])("rejects an invalid or overflowing timestamp %s before scheduling", (now) => {
    expect(() => quietUntil(quiet(), now)).toThrow(RangeError)
    expect(() => quietUntil(null, now)).toThrow(RangeError)
  })

  it.each([
    { timeZone: "Not/A_Zone", start: "22:00", end: "07:00" },
    { timeZone: "+08:00", start: "22:00", end: "07:00" },
    { timeZone: "Asia/Taipei", start: "24:00", end: "07:00" },
    { timeZone: "Asia/Taipei", start: "9:00", end: "17:00" },
    { timeZone: "Asia/Taipei", start: "22:00", end: "07:60" },
    { timeZone: "Asia/Taipei", start: "22:00:00", end: "07:00" },
    { timeZone: "Asia/Taipei", start: "22:00", end: "07:00\n" },
    { timeZone: "Asia/Taipei", start: "07:00", end: "07:00" },
  ])("requires quiet fields to pass policy validation: %j", (quietHours) => {
    expect(
      statusNotificationsSchema.safeParse({ ...initialStatusNotifications(), quietHours }).success,
    ).toBe(false)
  })
})

describe("service status daylight-saving boundaries", () => {
  it("shortens an overnight New York window at the spring transition", () => {
    const rule = quiet("America/New_York", "22:00", "03:30")
    expect(until(rule, "2030-03-10T03:00:00Z")).toBe("2030-03-10T07:30:00.000Z")
    expect(until(rule, "2030-03-10T07:29:59.999Z")).toBe("2030-03-10T07:30:00.000Z")
    expect(until(rule, "2030-03-10T07:30:00Z")).toBeNull()
  })

  it("shifts a nonexistent New York end forward by the gap", () => {
    const rule = quiet("America/New_York", "01:30", "02:30")
    expect(until(rule, "2030-03-10T06:30:00Z")).toBe("2030-03-10T07:30:00.000Z")
    expect(until(rule, "2030-03-10T07:15:00Z")).toBe("2030-03-10T07:30:00.000Z")
    expect(until(rule, "2030-03-10T07:30:00Z")).toBeNull()
  })

  it("shifts a nonexistent New York start forward instead of starting early", () => {
    const rule = quiet("America/New_York", "02:30", "04:00")
    expect(until(rule, "2030-03-10T07:15:00Z")).toBeNull()
    expect(until(rule, "2030-03-10T07:30:00Z")).toBe("2030-03-10T08:00:00.000Z")
  })

  it("does not create a window if compatible gap disambiguation puts its start after its end", () => {
    expect(until(quiet("America/New_York", "02:30", "03:00"), "2030-03-10T07:45:00Z")).toBeNull()
  })

  it("extends an overnight New York window across the repeated fall hour", () => {
    const rule = quiet("America/New_York", "22:00", "02:30")
    expect(until(rule, "2030-11-03T02:00:00Z")).toBe("2030-11-03T07:30:00.000Z")
    expect(until(rule, "2030-11-03T06:15:00Z")).toBe("2030-11-03T07:30:00.000Z")
    expect(until(rule, "2030-11-03T07:30:00Z")).toBeNull()
  })

  it("uses the earlier repeated start and includes the intervening repeated hour", () => {
    const rule = quiet("America/New_York", "01:30", "02:30")
    expect(until(rule, "2030-11-03T05:29:59.999Z")).toBeNull()
    expect(until(rule, "2030-11-03T05:30:00Z")).toBe("2030-11-03T07:30:00.000Z")
    expect(until(rule, "2030-11-03T06:10:00Z")).toBe("2030-11-03T07:30:00.000Z")
  })

  it("uses the earlier repeated end and does not reopen the window in the second hour", () => {
    const rule = quiet("America/New_York", "01:30", "01:45")
    expect(until(rule, "2030-11-03T05:30:00Z")).toBe("2030-11-03T05:45:00.000Z")
    expect(until(rule, "2030-11-03T05:45:00Z")).toBeNull()
    expect(until(rule, "2030-11-03T06:30:00Z")).toBeNull()
    expect(until(quiet("America/New_York", "22:00", "01:30"), "2030-11-03T06:15:00Z")).toBeNull()
  })

  it("uses European transition dates and offsets", () => {
    const rule = quiet("Europe/Berlin", "01:30", "03:30")
    expect(until(rule, "2030-03-31T00:30:00Z")).toBe("2030-03-31T01:30:00.000Z")
    expect(until(rule, "2030-03-31T01:30:00Z")).toBeNull()
    expect(until(rule, "2030-10-26T23:30:00Z")).toBe("2030-10-27T02:30:00.000Z")
    expect(until(rule, "2030-10-27T01:15:00Z")).toBe("2030-10-27T02:30:00.000Z")
    expect(until(rule, "2030-10-27T02:30:00Z")).toBeNull()
  })
})

describe("service status resolved-rule fingerprints", () => {
  it("uses deterministic SHA-256 and ignores array and object key order", () => {
    const original = subscription()
    const reordered: StatusSubscription = {
      includeMaintenance: original.includeMaintenance,
      notifyResolved: original.notifyResolved,
      notifyUpdates: original.notifyUpdates,
      batchWindowSeconds: original.batchWindowSeconds,
      quietHours: { end: "07:00", start: "22:00", timeZone: "Asia/Taipei" },
      componentSelections: {
        cloudflare: ["edge"],
        claude: [],
        openai: null,
        github: ["web", "api"],
      },
      minimumImpact: original.minimumImpact,
      providers: ["openai", "github"],
      chatId: original.chatId,
    }
    expect(statusRuleFingerprint(original)).toMatch(/^[a-f0-9]{64}$/)
    expect(statusRuleFingerprint(reordered)).toBe(statusRuleFingerprint(original))
  })

  it.each<Partial<StatusSubscription>>([
    { chatId: -202 },
    { providers: ["github"] },
    { minimumImpact: "critical" },
    { componentSelections: { github: ["api"], openai: null, claude: [], cloudflare: ["edge"] } },
    {
      componentSelections: { github: ["api", "web"], openai: [], claude: [], cloudflare: ["edge"] },
    },
    { componentSelections: { github: ["api", "web"], openai: null, claude: [], cloudflare: null } },
    { quietHours: null },
    { quietHours: quiet("UTC") },
    { quietHours: quiet("Asia/Taipei", "23:00") },
    { quietHours: quiet("Asia/Taipei", "22:00", "08:00") },
    { batchWindowSeconds: 0 },
    { batchWindowSeconds: 60 },
    { batchWindowSeconds: 900 },
    { notifyUpdates: false },
    { notifyResolved: false },
    { includeMaintenance: true },
  ])("includes every resolved field: %j", (change) => {
    expect(statusRuleFingerprint(subscription(change))).not.toBe(
      statusRuleFingerprint(subscription()),
    )
  })

  it("preserves a rule across unrelated shared-setting changes", () => {
    const settings = { ...initialStatusNotifications(), chatIds: [101] }
    const original = resolveStatusSubscription(settings, 101)
    const changed = resolveStatusSubscription(
      { ...settings, pollIntervalSeconds: 3600, enabled: true },
      101,
    )
    if (!original || !changed) throw new Error("Expected a selected destination")
    expect(statusRuleFingerprint(changed)).toBe(statusRuleFingerprint(original))
  })

  it("does not sort or rewrite the subscription in place", () => {
    const rule = subscription({ providers: ["openai", "github"] })
    rule.componentSelections.github = ["web", "api"]
    const before = structuredClone(rule)
    statusRuleFingerprint(rule)
    expect(rule).toEqual(before)
  })
})
