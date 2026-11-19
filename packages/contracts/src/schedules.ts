/** Absolute Unix milliseconds; recurrence is elapsed time, not local wall-clock time. */
export interface ScheduleInput {
  chatId: number
  task: string
  runAt: number
  timeZone: string
  repeatMinutes: 60 | 1440 | 10080 | null
}

export type ScheduleState = "active" | "paused" | "completed"
export type ScheduleOutcome = "running" | "succeeded" | "failed" | "interrupted"

export interface Schedule extends ScheduleInput {
  id: string
  revision: number
  state: ScheduleState
  createdAt: number
  nextRunAt: number | null
  lastRunAt: number | null
  lastOutcome: ScheduleOutcome | null
}

/** At most 100 schedules, including completed entries. Delete entries to release space. */
export interface ScheduleList {
  items: Schedule[]
  limit: number
}
