import { setTimeout as delay } from "node:timers/promises"
import { StdioTransport } from "@earendil-works/pi-mcp"

/** Keep ownership of the group after an unexpected leader exit (Pi 1.0.2 drops its pid then). */
export class ManagedStdioTransport extends StdioTransport {
  #group?: number
  #cleanup?: Promise<void>

  override async start(): Promise<void> {
    await super.start()
    if (process.platform !== "win32") this.#group = this.pid
    this.onClose(() => {
      void this.cleanGroup()
    })
  }

  private cleanGroup(): Promise<void> {
    this.#cleanup ??= (async () => {
      if (!this.#group) return
      try {
        process.kill(-this.#group, "SIGTERM")
      } catch {
        return
      }
      await delay(100)
      try {
        process.kill(-this.#group, "SIGKILL")
      } catch {
        /* Already gone. */
      }
    })()
    return this.#cleanup
  }

  override async close(): Promise<void> {
    try {
      await super.close()
    } finally {
      await this.cleanGroup()
    }
  }
}
