import { startApplication } from "./startup.js"

try {
  await startApplication()
} catch {
  // Startup records the failure with the configured logger before its final shutdown.
  process.exitCode = 1
}
