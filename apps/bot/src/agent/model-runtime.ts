import path from "node:path"

import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent"
import { createOAuthLogin } from "@narumitw/sumire-login"

import type { Settings } from "../config/settings.js"

export async function createBotModelRuntime(settings: Settings, agentDir: string) {
  const nativeOpenai = settings.openaiBaseUrl === "https://api.openai.com/v1"
  const apiKey = settings.openaiApiKey
  const canLogin =
    nativeOpenai &&
    settings.botAdminId !== undefined &&
    settings.botWhitelist.has(settings.botAdminId)
  if (!nativeOpenai && !apiKey) {
    throw new Error("OPENAI_API_KEY is required for a custom OPENAI_BASE_URL")
  }

  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(agentDir, "models-store.json"),
    refreshOnCreate: false,
  })
  const providerId = nativeOpenai ? "openai" : "telegramagent-openai"
  if (nativeOpenai) {
    // A configured key preserves Pi's stored-credential priority; a runtime key overrides OAuth.
    if (apiKey) modelRuntime.registerProvider(providerId, { apiKey })
  } else {
    modelRuntime.registerProvider(providerId, {
      name: "telegramagent OpenAI-compatible provider",
      baseUrl: settings.openaiBaseUrl,
      api: "openai-completions",
      authHeader: true,
      models: [
        {
          id: settings.openaiModel,
          name: settings.openaiModel,
          reasoning: false,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: settings.botAgentContextTokenBudget,
          maxTokens: Math.min(
            settings.botAgentContextTokenBudget,
            Math.max(1, Math.min(32_768, Math.floor(settings.botAgentContextTokenBudget * 0.2))),
          ),
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        },
      ],
    })
    if (apiKey) await modelRuntime.setRuntimeApiKey(providerId, apiKey)
  }
  const model = modelRuntime.getModel(providerId, settings.openaiModel)
  if (!model) throw new Error(`Pi model not found: ${providerId}/${settings.openaiModel}`)

  if (nativeOpenai && !canLogin && !(await modelRuntime.checkAuth(providerId))) {
    throw new Error(
      "OpenAI requires OPENAI_API_KEY or BOT_ADMIN_ID explicitly listed in BOT_WHITELIST for /login",
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
