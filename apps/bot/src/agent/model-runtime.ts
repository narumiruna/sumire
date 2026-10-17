import path from "node:path"

import { ModelRuntime } from "@earendil-works/pi-coding-agent"

const initialModelId = "gpt-6.1-sol"

export async function createBotModelRuntime(agentDir: string, suppliedModelRuntime?: ModelRuntime) {
  const modelRuntime =
    suppliedModelRuntime ??
    (await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: null,
      modelsStorePath: path.join(agentDir, "models-store.json"),
      refreshOnCreate: false,
    }))
  const model = modelRuntime.getModel("openai", initialModelId)
  if (!model) throw new Error(`Pi model not found: openai/${initialModelId}`)

  return { modelRuntime, model }
}
