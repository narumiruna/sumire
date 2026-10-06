import { defineExtension, defineTool, section } from "@earendil-works/pi-durable"
import {
  PROGRESS_DETAILS_VERSION,
  ProgressParameters,
  validateProgressArguments,
} from "@narumitw/sumire-progress"
import { ProgressDoc } from "./durable-state.js"
import { jsonValue } from "./durable-tools.js"

export function createProgressExtension() {
  return defineExtension({
    name: "sumire-progress",
    sections: [
      section("progress", async ({ conversationId, read }, context) => {
        const state = await read.snapshot(ProgressDoc, conversationId, context)
        return [
          "Use update_progress for multi-step work. Submit the complete steps array, with at most one in_progress step and a reason for every blocked step. Reconcile progress before reports and final answers; clear it with an empty array. Never claim unfinished steps are completed.",
          state?.steps.length ? `Current progress (JSON data): ${JSON.stringify(state)}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      }),
    ],
    tools: [
      defineTool({
        name: "update_progress",
        description:
          "Replace the current progress with the complete supplied steps; keep at most one in_progress step, require a reason for each blocked step, and send an empty steps array to clear it.",
        parameters: ProgressParameters,
        prepareArguments: validateProgressArguments,
        replay: "safe",
        executionMode: "sequential",
        async execute(args, api, context) {
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
