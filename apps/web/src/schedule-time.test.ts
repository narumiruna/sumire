import { afterEach, describe, expect, it, vi } from "vitest"
import { setLocale } from "./i18n.js"
import { formatScheduleTime, localScheduleTime, parseScheduleTime } from "./schedule-time.js"

afterEach(() => {
  vi.unstubAllEnvs()
  setLocale("en")
})
describe("schedule dates", () => {
  it("converts the browser-local input to an absolute UTC instant", () => {
    vi.stubEnv("TZ", "Asia/Taipei")
    expect(parseScheduleTime("2026-11-20T09:30")).toBe(Date.parse("2026-11-20T01:30:00Z"))
    expect(localScheduleTime(new Date("2026-11-20T01:30:00Z"))).toBe("2026-11-20T09:30")
  })
  it.each([
    "",
    "2026-02-30T09:30",
    "2026-13-01T09:30",
    "2026-11-20",
    "2026-11-20T25:00",
    "2026-11-20T09:30Z",
    "2026-11-20T09:30:30",
  ])("rejects invalid local input %j", (value) => {
    expect(() => parseScheduleTime(value)).toThrow()
  })
  it("rejects a nonexistent DST clock time instead of silently normalizing", () => {
    vi.stubEnv("TZ", "America/New_York")
    expect(() => parseScheduleTime("2026-03-08T02:30")).toThrow()
    expect(parseScheduleTime("2026-03-08T03:30")).toBe(Date.parse("2026-03-08T07:30:00Z"))
  })
  it("previews the earlier offset for an ambiguous fall-back hour", () => {
    vi.stubEnv("TZ", "America/New_York")
    const time = parseScheduleTime("2026-11-01T01:30")
    expect(time).toBe(Date.parse("2026-11-01T05:30:00Z"))
    expect(formatScheduleTime(time, "America/New_York")).toContain("GMT-4")
  })
  it("renders the saved time zone even from a different browser zone", () => {
    vi.stubEnv("TZ", "America/Los_Angeles")
    const time = Date.parse("2026-11-20T01:30:00Z")
    setLocale("zh-TW")
    expect(formatScheduleTime(time, "Asia/Taipei")).toContain("GMT+8")
  })
})
