import { type RunnerHandle, run } from "@grammyjs/runner"
import { type Bot, type BotError, GrammyError, HttpError } from "grammy"

import type { Logger } from "../logging.js"

const retryIntervalMs = 5_000
const warningIntervalMs = 60_000

export function runTelegramPolling(bot: Bot, logger: Logger): RunnerHandle {
  let failures = 0
  let lastWarningAt = 0

  return run(
    {
      init: () => bot.init(),
      handleUpdate: bot.handleUpdate.bind(bot),
      errorHandler: (error: BotError) => bot.errorHandler(error),
      api: {
        async getUpdates(args, signal) {
          // The runner may finish a retry delay after shutdown was requested.
          if (signal.aborted) throw new Error("Telegram polling stopped")
          try {
            const updates = await bot.api.getUpdates(args, signal)
            if (failures > 0 && !signal.aborted) {
              logger.info("Telegram polling recovered", { failures })
            }
            failures = 0
            return updates
          } catch (error) {
            if (signal.aborted) throw error
            // Let the application report fatal configuration errors and exit.
            if (
              error instanceof GrammyError &&
              (error.error_code === 401 || error.error_code === 409)
            ) {
              throw error
            }
            failures++
            const now = Date.now()
            if (failures === 1 || now - lastWarningAt >= warningIntervalMs) {
              lastWarningAt = now
              const cause = error instanceof HttpError ? error.error : error
              logger.warn("Telegram polling failed; retrying automatically", {
                failures,
                error: cause instanceof Error ? cause.message : cause,
              })
            }
            throw error
          }
        },
      },
    },
    {
      runner: {
        fetch: { allowed_updates: ["message"] },
        // Avoid the runner's raw console output, which can expose bot tokens.
        silent: true,
        // Unbounded exponential delays can leave a recovered connection idle for hours.
        retryInterval: retryIntervalMs,
      },
      sink: { concurrency: 16 },
    },
  )
}
