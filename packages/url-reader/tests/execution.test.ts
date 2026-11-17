import { afterEach, describe, expect, it, vi } from "vitest"
import type { FailurePhase } from "../src/core/errors.js"
import { createAttemptExecution, reportPhase } from "../src/core/execution.js"

afterEach(() => vi.restoreAllMocks())

describe("attempt execution stages", () => {
  it("sums repeated timed stages without resetting repeated reports and freezes snapshots", async () => {
    let now = 0
    vi.spyOn(performance, "now").mockImplementation(() => now)
    const execution = createAttemptExecution()
    await execution.run(async () => {
      reportPhase("metadata")
      now = 10
      reportPhase("metadata")
      now = 20
      reportPhase("download")
      now = 25
      reportPhase("metadata")
      now = 30
    })
    expect(execution.finish()).toEqual({
      phase: "metadata",
      phaseTimingsMs: { metadata: 25, download: 5 },
    })
    now = 100
    await execution.run(async () => reportPhase("inference"))
    expect(execution.finish()).toEqual({
      phase: "metadata",
      phaseTimingsMs: { metadata: 25, download: 5 },
    })
    const snapshot = execution.finish()
    if (snapshot.phaseTimingsMs) snapshot.phaseTimingsMs.metadata = 999
    expect(execution.finish().phaseTimingsMs?.metadata).toBe(25)
  })

  it("ignores unknown phase values and emits no timings for unreported or legacy stages", async () => {
    reportPhase("inference")
    const empty = createAttemptExecution()
    await empty.run(async () =>
      reportPhase("https://user:secret@example.com/private" as FailurePhase),
    )
    expect(empty.finish()).toEqual({})
    const captions = createAttemptExecution()
    await captions.run(async () => reportPhase("captions"))
    expect(captions.finish()).toEqual({ phase: "captions" })
  })
})
