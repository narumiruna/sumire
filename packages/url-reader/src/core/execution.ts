import { AsyncLocalStorage } from "node:async_hooks"

import type { FailureDiagnostic, FailurePhase } from "./errors.js"
import type { AttemptRecord } from "./results.js"

interface AttemptState {
  phase?: FailurePhase
  phaseStarted?: number
  phaseTimingsMs: Partial<Record<FailurePhase, number>>
  finished: boolean
}

interface ExecutionContext {
  deadlineAt?: number
  attempts?: AttemptRecord[]
  attempt?: AttemptState
}

export interface AttemptSnapshot {
  phase?: FailurePhase
  phaseTimingsMs?: Partial<Record<FailurePhase, number>>
}

const phases = new Set<FailurePhase>([
  "captions",
  "metadata",
  "download",
  "decode",
  "model_load",
  "inference",
  "transcription",
  "loading",
  "validation",
])
const timedPhases = new Set<FailurePhase>([
  "metadata",
  "download",
  "decode",
  "model_load",
  "inference",
])

const execution = new AsyncLocalStorage<ExecutionContext>()

function mergedContext(patch: Partial<ExecutionContext>): ExecutionContext {
  return { ...execution.getStore(), ...patch }
}

export function withDeadline<T>(
  deadlineAt: number | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  return execution.run(mergedContext({ deadlineAt }), operation)
}

export function withAttemptSink<T>(
  attempts: AttemptRecord[],
  operation: () => Promise<T>,
): Promise<T> {
  return execution.run(mergedContext({ attempts }), operation)
}

/** Creates isolated stage state that stops accepting updates when the attempt finishes. */
export function createAttemptExecution(): {
  run<T>(operation: () => Promise<T>): Promise<T>
  finish(): AttemptSnapshot
} {
  const attempt: AttemptState = { phaseTimingsMs: {}, finished: false }
  return {
    run: (operation) => execution.run(mergedContext({ attempt }), operation),
    finish: () => {
      if (!attempt.finished) {
        accumulatePhase(attempt, performance.now())
        attempt.finished = true
      }
      return {
        ...(attempt.phase ? { phase: attempt.phase } : {}),
        ...(Object.keys(attempt.phaseTimingsMs).length > 0
          ? { phaseTimingsMs: { ...attempt.phaseTimingsMs } }
          : {}),
      }
    },
  }
}

/** Records the confirmed stage before work starts; ignores unknown values and late work. */
export function reportPhase(phase: FailureDiagnostic["phase"]): void {
  const attempt = execution.getStore()?.attempt
  if (!attempt || attempt.finished || !phase || !phases.has(phase) || attempt.phase === phase)
    return
  const now = performance.now()
  accumulatePhase(attempt, now)
  attempt.phase = phase
  attempt.phaseStarted = now
}

function accumulatePhase(attempt: AttemptState, now: number): void {
  if (!attempt.phase || !timedPhases.has(attempt.phase) || attempt.phaseStarted === undefined)
    return
  const elapsed = Math.max(0, now - attempt.phaseStarted)
  if (!Number.isFinite(elapsed)) return
  attempt.phaseTimingsMs[attempt.phase] = Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.round((attempt.phaseTimingsMs[attempt.phase] ?? 0) + elapsed),
  )
}

export function remainingMilliseconds(): number | undefined {
  const deadlineAt = execution.getStore()?.deadlineAt
  return deadlineAt === undefined ? undefined : Math.max(0, deadlineAt - performance.now())
}

export function recordAttempt(record: AttemptRecord): void {
  execution.getStore()?.attempts?.push(record)
}
