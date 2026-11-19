import { getLocale, LocalizedError } from "./i18n.js"

export function localScheduleTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
/** Reject normalized dates and DST gaps instead of silently selecting another wall-clock time. */
export function parseScheduleTime(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value))
    throw new LocalizedError("schedule.invalidTime")
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || localScheduleTime(date) !== value)
    throw new LocalizedError("schedule.invalidTime")
  return date.getTime()
}
export function formatScheduleTime(value: number, timeZone: string): string {
  return new Intl.DateTimeFormat(getLocale(), {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "shortOffset",
  }).format(value)
}
