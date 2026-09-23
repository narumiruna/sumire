export interface ProgressStep {
  text: string
  status: "pending" | "in_progress" | "completed" | "blocked"
  reason?: string
}

// pi-progress stores successful update_progress results as version 4 details.
export function parsePiProgressDetails(details: unknown): readonly ProgressStep[] | undefined {
  if (!details || typeof details !== "object" || !("version" in details)) return undefined
  if (details.version !== 4 || !("steps" in details) || !Array.isArray(details.steps))
    return undefined
  if (
    details.steps.length > 50 ||
    !details.steps.every(
      (step: unknown) =>
        step !== null &&
        typeof step === "object" &&
        "text" in step &&
        typeof step.text === "string" &&
        step.text.trim().length > 0 &&
        "status" in step &&
        (step.status === "pending" ||
          step.status === "in_progress" ||
          step.status === "completed" ||
          step.status === "blocked") &&
        (step.status === "blocked"
          ? "reason" in step && typeof step.reason === "string" && step.reason.trim().length > 0
          : !("reason" in step)),
    ) ||
    details.steps.filter((step: ProgressStep) => step.status === "in_progress").length > 1
  )
    return undefined
  return details.steps as ProgressStep[]
}
