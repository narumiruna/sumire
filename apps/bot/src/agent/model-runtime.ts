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
  const canLogin =
    settings.botAdminId !== undefined && settings.botWhitelist.has(settings.botAdminId)
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

  if (!canLogin && (await modelRuntime.getAvailable()).length === 0) {
    throw new Error(
      "Pi requires credentials for an available chat model or BOT_ADMIN_ID explicitly listed in BOT_WHITELIST for /login",
    )
  }

  const authSettings = SettingsManager.create(settings.botWorkdir, agentDir, {
    projectTrusted: false,
  })
  const login = canLogin
    ? createOAuthLogin(modelRuntime, {
        getDeviceId: () => authSettings.getOrCreateDeviceId(),
      })
    : undefined
  return { modelRuntime, model, login }
}
