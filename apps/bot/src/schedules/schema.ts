import type { DatabaseSync } from "node:sqlite"
import { z } from "zod"

export const scheduleLimit = 100
export const scheduleTaskLimit = 8000
export const scheduleInput = z.strictObject({
  chatId: z
    .number()
    .int()
    .safe()
    .refine((id) => id !== 0),
  task: z.string().trim().min(1).max(scheduleTaskLimit),
  runAt: z.number().int().safe().min(0).max(8_640_000_000_000_000),
  timeZone: z
    .string()
    .min(1)
    .max(64)
    .refine((zone) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: zone }).format(0)
        return true
      } catch {
        return false
      }
    }, "Invalid time zone"),
  repeatMinutes: z.union([z.literal(60), z.literal(1440), z.literal(10080), z.null()]),
})
export const scheduleCreation = scheduleInput.extend({
  requestId: z.uuid().transform((id) => id.toLowerCase()),
})
export const scheduleMutation = z.strictObject({
  revision: z.number().int().safe().positive(),
  action: z.enum(["pause", "resume"]),
})
export const scheduleDeletion = z.strictObject({ revision: z.number().int().safe().positive() })

/** Additive storage, initialized in the AdminStore migration transaction. */
export function initializeScheduleStorage(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    task TEXT NOT NULL,
    run_at INTEGER NOT NULL,
    time_zone TEXT NOT NULL,
    repeat_minutes INTEGER CHECK(repeat_minutes IN (60,1440,10080)),
    state TEXT NOT NULL CHECK(state IN ('active','paused','completed')),
    revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    next_run_at INTEGER,
    last_run_at INTEGER,
    last_outcome TEXT CHECK(last_outcome IN ('running','succeeded','failed','interrupted')),
    run_id TEXT,
    actor TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS scheduled_tasks_due ON scheduled_tasks(state, next_run_at);`)
}
