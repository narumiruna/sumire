import type { Schedule } from "@narumitw/sumire-contracts"
import type { Logger } from "../logging.js"
import type { ScheduleStore } from "./store.js"

/** Bounded transport dispatcher only. Pi Durable continues to own every model/tool turn. */
export class ScheduleWorker {
  #timer?: ReturnType<typeof setInterval>
  #started = false
  #stopped = false
  #busy = false
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
    // Do not abort admitted Pi work or wait for a model here. Registry disposal pauses it.
    // A stopped callback never touches AdminStore, which may close during application shutdown.
  }
  async tick(now = Date.now()): Promise<void> {
    if (!this.#started || this.#stopped || this.#busy) return
    this.#busy = true
    try {
      const run = this.schedules.claim(now)
      if (!run) return
      const isCurrent = () => !this.#stopped && this.schedules.control.allows(run.schedule.chatId)
      let succeeded = false
      try {
        this.schedules.control.assertChat(run.schedule.chatId)
        await this.execute(run.schedule, isCurrent)
        succeeded = isCurrent()
      } catch {
        // Never log the user message, Telegram payload, upstream error, or credentials.
        this.logger.warn("Scheduled task requires review", {
          "event.name": "schedule.execution.failed",
          "schedule.id": run.schedule.id,
        })
      }
      if (!this.#stopped) this.schedules.finish(run, succeeded)
    } catch {
      this.logger.warn("Schedule dispatcher could not update storage", {
        "event.name": "schedule.dispatch.failed",
      })
    } finally {
      this.#busy = false
    }
  }
}
