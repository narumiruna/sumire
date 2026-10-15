import { defineExtension, defineTool, section } from "@earendil-works/pi-durable"
import {
  PROGRESS_DETAILS_VERSION,
  ProgressParameters,
  parseProgressDetails,
  validateProgressArguments,
} from "@narumitw/sumire-progress"
import { ProgressDoc } from "./durable-state.js"
import { jsonValue } from "./durable-tools.js"

export function createProgressExtension(authorize: () => void = () => {}) {
  return defineExtension({
    name: "sumire-progress",
    sections: [
      section("progress", async ({ conversationId, read }, context) => {
        const state = await read.snapshot(ProgressDoc, conversationId, context)
        const details =
          parseProgressDetails({ version: PROGRESS_DETAILS_VERSION, steps: state?.steps ?? [] }) ??
          parseProgressDetails({ version: 1, steps: state?.steps ?? [] })
        return [
          "Use update_progress for multi-step work. Submit the complete steps array, with at most one in_progress step. Describe external blockers in the step text. Mark a step in_progress before starting it and completed when it finishes. Reconcile progress before reports and final answers; clear it with an empty array. Never claim unfinished steps are completed.",
          details?.steps.length ? `Current progress (JSON data): ${JSON.stringify(details)}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      }),
    ],
    tools: [
      defineTool({
        name: "update_progress",
        description:
          "Replace the current progress with the complete supplied steps; keep at most one in_progress step, and send an empty steps array to clear it.",
        parameters: ProgressParameters,
        prepareArguments: validateProgressArguments,
        replay: "safe",
        executionMode: "sequential",
        async execute(args, api, context) {
          authorize()
          const details = jsonValue({
            version: PROGRESS_DETAILS_VERSION,
            steps: validateProgressArguments(args).steps,
          })
          await api.commit(async (tx) => {
            const state = await tx.doc(ProgressDoc, api.conversationId)
            state.steps = details.steps
          }, context)
          const completed = details.steps.filter((step) => step.status === "completed").length
          return {
            content: [
              {
                type: "text",
                text: details.steps.length
                  ? `Progress updated: ${completed} of ${details.steps.length} complete.`
                  : "Progress cleared.",
              },
            ],
            details,
          }
        },
      }),
    ],
  })
}
