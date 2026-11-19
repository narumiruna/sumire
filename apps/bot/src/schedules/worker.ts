import type { Schedule } from "@narumitw/sumire-contracts"
import type { Logger } from "../logging.js"
import type { ScheduleRun, ScheduleStore } from "./store.js"

/** Bounded transport dispatcher only. Pi Durable continues to own every model/tool turn. */
export class ScheduleWorker {
  #timer?: ReturnType<typeof setInterval>
  #started = false
  #stopped = false
  #busy = false
  #pendingCompletion: { run: ScheduleRun; succeeded: boolean; completedAt: number } | undefined
  constructor(
    readonly schedules: ScheduleStore,
    private readonly execute: (schedule: Schedule, isCurrent: () => boolean) => Promise<void>,
    private readonly logger: Logger,
  ) {}
  start(): void {
    if (this.#started || this.#stopped) return
    this.schedules.recoverInterrupted()
    this.#started = true
    this.#timer = setInterval(() => void this.tick(), 1000)
    this.#timer.unref()
    void this.tick()
  }
  stop(): void {
    this.#stopped = true
    clearInterval(this.#timer)
    this.#pendingCompletion = undefined
    // Do not abort admitted Pi work or wait for a model here. Registry disposal pauses it.
    // A stopped callback never touches AdminStore, which may close during application shutdown.
  }
  async tick(now = Date.now()): Promise<void> {
    if (!this.#started || this.#stopped || this.#busy) return
    this.#busy = true
    try {
      if (!this.#pendingCompletion) {
        const run = this.schedules.claim(now)
        if (!run) return
        const succeeded = await this.#executeRun(run)
        if (this.#stopped) return
        this.#pendingCompletion = { run, succeeded, completedAt: Date.now() }
      }
      // Clear only after persistence succeeds. A retry must not run the task again.
      const { run, succeeded, completedAt } = this.#pendingCompletion
      this.schedules.finish(run, succeeded, Math.max(completedAt, Date.now()))
      this.#pendingCompletion = undefined
    } catch {
      this.logger.warn("Schedule dispatcher could not update storage", {
        "event.name": "schedule.dispatch.failed",
      })
    } finally {
      this.#busy = false
    }
  }

  async #executeRun(run: ScheduleRun): Promise<boolean> {
    const isCurrent = () => !this.#stopped && this.schedules.control.allows(run.schedule.chatId)
    try {
      this.schedules.control.assertChat(run.schedule.chatId)
      await this.execute(run.schedule, isCurrent)
      return isCurrent()
    } catch {
      // Never log the user message, Telegram payload, upstream error, or credentials.
      this.logger.warn("Scheduled task requires review", {
        "event.name": "schedule.execution.failed",
        "schedule.id": run.schedule.id,
      })
      return false
    }
  }
}
