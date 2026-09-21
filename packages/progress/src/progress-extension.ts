import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

import {
  cloneProgressSteps,
  PROGRESS_DETAILS_VERSION,
  PROGRESS_TOOL_NAME,
  type ProgressDetails,
  ProgressParameters,
  type ProgressStep,
  reconcileProgressContext,
  reconstructProgress,
  validateProgressArguments,
} from "./progress-state.js"

export default function progressExtension(pi: ExtensionAPI): void {
  let activeSession: ExtensionContext["sessionManager"] | undefined
  let steps: ProgressStep[] = []

  const ownsSession = (ctx: ExtensionContext): boolean => ctx.sessionManager === activeSession

  pi.registerTool({
    name: PROGRESS_TOOL_NAME,
    label: "Progress",
    description:
      "Replace the current session progress state with the complete supplied steps. Call update_progress whenever actual step state changes; keep at most one step in_progress, require a reason for each blocked step, and send an empty steps array to clear it.",
    promptSnippet: "Maintain the complete session progress state as multi-step work progresses",
    promptGuidelines: [
      "Use update_progress to track work with multiple meaningful steps; skip it for simple, single-step tasks.",
      "Use update_progress to keep the progress state aligned with actual work: mark a step in_progress before starting it, mark it completed as soon as it finishes, and revise the steps before continuing when the plan changes.",
      "Use blocked with a concise reason only when progress depends on an external action or condition; blocked does not mean completed.",
      "Before a progress report or final response, call update_progress to reconcile every step with actual work; do not report completion while the progress state is stale.",
      "On every update_progress call, send the complete current steps array, keep at most one step in_progress, and send an empty steps array when no tracked work remains.",
    ],
    parameters: ProgressParameters,
    prepareArguments: validateProgressArguments,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted()
      if (!ownsSession(ctx)) throw new Error("Cannot update progress because the session changed.")

      steps = cloneProgressSteps(validateProgressArguments(params).steps)
      const details: ProgressDetails = {
        version: PROGRESS_DETAILS_VERSION,
        steps: cloneProgressSteps(steps),
      }
      if (steps.length === 0) {
        return { content: [{ type: "text", text: "Progress cleared." }], details }
      }

      const completed = steps.filter((step) => step.status === "completed").length
      const blocked = steps.filter((step) => step.status === "blocked").length
      const active = steps.some((step) => step.status === "in_progress")
      const suffixes = [
        ...(active ? ["1 in progress"] : []),
        ...(blocked > 0 ? [`${blocked} blocked`] : []),
      ]
      return {
        content: [
          {
            type: "text",
            text: `Progress updated: ${completed} of ${steps.length} complete${suffixes.length > 0 ? `; ${suffixes.join("; ")}` : ""}.`,
          },
        ],
        details,
      }
    },
  })

  pi.on("session_start", (_event, ctx) => {
    activeSession = ctx.sessionManager
    steps = reconstructProgress(ctx.sessionManager.getBranch())
  })

  pi.on("context", (event, ctx) => {
    if (!ownsSession(ctx)) return
    const messages = reconcileProgressContext(event.messages, steps)
    if (messages !== event.messages) return { messages }
  })

  pi.on("session_tree", (_event, ctx) => {
    if (!ownsSession(ctx)) return
    steps = reconstructProgress(ctx.sessionManager.getBranch())
  })

  pi.on("session_shutdown", (_event, ctx) => {
    if (!ownsSession(ctx)) return
    steps = []
    activeSession = undefined
  })
}
