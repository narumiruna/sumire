import { randomUUID } from "node:crypto"
import type { Schedule, ScheduleInput, ScheduleList } from "@narumitw/sumire-contracts"
import { AdminError, type AdminStore } from "../admin/store.js"
import { scheduleInput, scheduleLimit } from "./schema.js"

type Row = {
  id: string
  chat_id: number
  task: string
  run_at: number
  time_zone: string
  repeat_minutes: Schedule["repeatMinutes"]
  state: Schedule["state"]
  revision: number
  created_at: number
  next_run_at: number | null
  last_run_at: number | null
  last_outcome: Schedule["lastOutcome"]
  run_id: string | null
  actor: string
}
export interface ScheduleRun {
  schedule: Schedule
  runId: string
}
const project = (row: Row): Schedule => ({
  id: row.id,
  chatId: row.chat_id,
  task: row.task,
  runAt: row.run_at,
  timeZone: row.time_zone,
  repeatMinutes: row.repeat_minutes,
  state: row.state,
  revision: row.revision,
  createdAt: row.created_at,
  nextRunAt: row.next_run_at,
  lastRunAt: row.last_run_at,
  lastOutcome: row.last_outcome,
})

/** Skip missed intervals; never replay a burst after downtime or a long model turn. */
export function nextScheduleTime(anchor: number, minutes: number, now: number): number {
  const interval = minutes * 60_000
  return anchor > now ? anchor : anchor + (Math.floor((now - anchor) / interval) + 1) * interval
}

/** One process owns AdminStore; every mutation and its content-free audit are atomic. */
export class ScheduleStore {
  constructor(readonly control: AdminStore) {}

  list(): ScheduleList {
    const rows = this.control.db
      .prepare("SELECT * FROM scheduled_tasks ORDER BY created_at DESC, id LIMIT ?")
      .all(scheduleLimit) as Row[]
    return { items: rows.map(project), limit: scheduleLimit }
  }
  private row(id: string): Row {
    const row = this.control.db.prepare("SELECT * FROM scheduled_tasks WHERE id=?").get(id) as
      | Row
      | undefined
    if (!row) throw new AdminError(404, "Schedule was not found")
    return row
  }
  private transaction<T>(work: () => T): T {
    this.control.db.exec("BEGIN IMMEDIATE")
    try {
      const result = work()
      this.control.db.exec("COMMIT")
      return result
    } catch (error) {
      this.control.db.exec("ROLLBACK")
      throw error
    }
  }
  private audit(actor: string, operation: string, id: string, outcome = "completed") {
    this.control.audit(
      actor,
      `schedule.${operation}`,
      this.control.snapshot().revision,
      outcome,
      `schedule:${id}`,
    )
  }
  create(
    input: ScheduleInput,
    actor: string,
    now = Date.now(),
    id: string = randomUUID(),
  ): Schedule {
    const value = scheduleInput.parse(input)
    return this.transaction(() => {
      const previous = this.control.db
        .prepare("SELECT * FROM scheduled_tasks WHERE id=?")
        .get(id) as Row | undefined
      if (previous) {
        if (
          previous.actor !== actor ||
          previous.chat_id !== value.chatId ||
          previous.task !== value.task ||
          previous.run_at !== value.runAt ||
          previous.time_zone !== value.timeZone ||
          previous.repeat_minutes !== value.repeatMinutes
        )
          throw new AdminError(409, "Creation request changed; start a new schedule")
        return project(previous)
      }
      if (value.runAt <= now) throw new AdminError(400, "Execution time must be in the future")
      this.control.assertChat(value.chatId)
      if (!this.control.db.prepare("SELECT id FROM chats WHERE id=?").get(value.chatId))
        throw new AdminError(400, "Select a known, allowed chat")
      const { count } = this.control.db
        .prepare("SELECT COUNT(*) AS count FROM scheduled_tasks")
        .get() as { count: number }
      if (count >= scheduleLimit)
        throw new AdminError(409, "Schedule limit reached; delete old entries first")
      this.control.db
        .prepare(`INSERT INTO scheduled_tasks
        (id,chat_id,task,run_at,time_zone,repeat_minutes,state,revision,created_at,next_run_at,actor)
        VALUES (?,?,?,?,?,?,'active',1,?,?,?)`)
        .run(
          id,
          value.chatId,
          value.task,
          value.runAt,
          value.timeZone,
          value.repeatMinutes,
          now,
          value.runAt,
          actor,
        )
      this.audit(actor, "create", id)
      return project(this.row(id))
    })
  }
  change(
    id: string,
    revision: number,
    action: "pause" | "resume",
    actor: string,
    now = Date.now(),
  ): Schedule {
    return this.transaction(() => {
      const row = this.row(id)
      if (row.revision !== revision)
        throw new AdminError(409, "Schedule changed; refresh before trying again")
      if (row.state !== (action === "pause" ? "active" : "paused"))
        throw new AdminError(409, "Schedule cannot perform this action")
      if (action === "resume" && row.last_outcome === "running")
        throw new AdminError(409, "Wait for the current execution before resuming")
      if (action === "resume" && row.next_run_at === null)
        throw new AdminError(409, "Inspect the previous execution before creating a replacement")
      if (action === "resume" && row.last_outcome === "interrupted")
        throw new AdminError(
          409,
          "Execution outcome is unknown; inspect the chat before creating a replacement",
        )
      if (action === "resume") this.control.assertChat(row.chat_id)
      const next =
        action === "resume" && row.repeat_minutes !== null
          ? nextScheduleTime(row.run_at, row.repeat_minutes, now)
          : row.next_run_at
      this.control.db
        .prepare("UPDATE scheduled_tasks SET state=?,next_run_at=?,revision=revision+1 WHERE id=?")
        .run(action === "pause" ? "paused" : "active", next, id)
      this.audit(actor, action, id)
      return project(this.row(id))
    })
  }
  delete(id: string, revision: number, actor: string): void {
    this.transaction(() => {
      const row = this.row(id)
      if (row.revision !== revision)
        throw new AdminError(409, "Schedule changed; refresh before deleting")
      this.control.db.prepare("DELETE FROM scheduled_tasks WHERE id=?").run(id)
      this.audit(actor, "delete", id)
    })
  }
  /** Claim before any I/O. A restart never automatically resubmits an uncertain attempt. */
  claim(now = Date.now()): ScheduleRun | undefined {
    return this.transaction(() => {
      const row = this.control.db
        .prepare(`SELECT * FROM scheduled_tasks
        WHERE state='active' AND next_run_at<=? AND (last_outcome IS NULL OR last_outcome<>'running')
        ORDER BY next_run_at,id LIMIT 1`)
        .get(now) as Row | undefined
      if (!row) return undefined
      const runId = randomUUID()
      this.control.db
        .prepare(
          "UPDATE scheduled_tasks SET last_outcome='running',last_run_at=?,run_id=?,revision=revision+1 WHERE id=?",
        )
        .run(now, runId, row.id)
      this.audit("system", "run", row.id, "started")
      return { schedule: project(this.row(row.id)), runId }
    })
  }
  finish(run: ScheduleRun, succeeded: boolean, now = Date.now()): void {
    this.transaction(() => {
      const row = this.control.db
        .prepare("SELECT * FROM scheduled_tasks WHERE id=? AND run_id=? AND last_outcome='running'")
        .get(run.schedule.id, run.runId) as Row | undefined
      if (!row) return // Deleting a dispatched task does not cancel its admitted model turn.
      const next =
        row.repeat_minutes === null ? null : nextScheduleTime(row.run_at, row.repeat_minutes, now)
      this.control.db
        .prepare(
          "UPDATE scheduled_tasks SET state=?,last_outcome=?,next_run_at=?,revision=revision+1 WHERE id=?",
        )
        .run(
          !succeeded ? "paused" : next === null ? "completed" : row.state,
          succeeded ? "succeeded" : "failed",
          next,
          row.id,
        )
      this.audit("system", "run", row.id, succeeded ? "succeeded" : "failed")
    })
  }
  recoverInterrupted(): void {
    this.transaction(() => {
      const rows = this.control.db
        .prepare("SELECT id FROM scheduled_tasks WHERE last_outcome='running'")
        .all() as { id: string }[]
      this.control.db.exec(
        "UPDATE scheduled_tasks SET state='paused',last_outcome='interrupted',revision=revision+1 WHERE last_outcome='running'",
      )
      for (const row of rows) this.audit("system", "run", row.id, "interrupted")
    })
  }
}
