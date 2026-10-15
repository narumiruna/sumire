import path from "node:path"

import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent"
import { createOAuthLogin } from "@narumitw/sumire-login"

import type { Settings } from "../config/settings.js"

const initialModelId = "gpt-6.1-sol"

export async function createBotModelRuntime(
  settings: Settings,
  agentDir: string,
  suppliedModelRuntime?: ModelRuntime,
) {
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

  const authSettings = SettingsManager.create(settings.botWorkdir, agentDir, {
    projectTrusted: false,
  })
  const login = createOAuthLogin(modelRuntime, {
    getDeviceId: () => authSettings.getOrCreateDeviceId(),
  })
  return { modelRuntime, model, login }
}
