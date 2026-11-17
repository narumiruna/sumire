import type { ChildProcess } from "node:child_process"

/** Register immediately after spawn, before handling streams or cancellation. */
export function audioProcessClosed(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => child.once("close", (code) => resolve(code)))
}

/** Native inference is not cooperatively cancellable. Capacity requires closure. */
export async function stopAudioProcess(
  child: ChildProcess,
  closed: Promise<number | null>,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    await closed
    return
  }
  child.kill("SIGTERM")
  const timer = setTimeout(() => child.kill("SIGKILL"), 200)
  try {
    await closed
  } finally {
    clearTimeout(timer)
  }
}
