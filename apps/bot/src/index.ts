import { createLogger } from "./logging.js"
import { startApplication } from "./startup.js"

try {
  await startApplication()
} catch (error) {
  // Do not let Node print raw errors with credential-bearing request URLs.
  createLogger().error("Application failed", error)
  process.exitCode = 1
}
