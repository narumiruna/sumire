import path from "node:path"

import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent"
import { createOAuthLogin } from "@narumitw/sumire-login"

import type { Settings } from "../config/settings.js"

export async function createBotModelRuntime(settings: Settings, agentDir: string) {
  const oauth = settings.openaiAuthMode === "oauth"
  const apiKey = settings.openaiApiKey
  if (oauth) {
    if (settings.botAdminId === undefined || !settings.botWhitelist.has(settings.botAdminId)) {
      throw new Error("OAuth mode requires BOT_ADMIN_ID explicitly listed in BOT_WHITELIST")
    }
    if (settings.openaiBaseUrl !== "https://api.openai.com/v1") {
      throw new Error("OAuth mode requires OPENAI_BASE_URL=https://api.openai.com/v1")
    }
  } else if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required in api_key mode")
  }

  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: path.join(agentDir, "models-store.json"),
    refreshOnCreate: false,
  })
  const providerId = oauth ? "openai" : "telegramagent-openai"
  if (oauth) {
    const provider = openaiProvider()
    // Keep Pi's native OAuth and Responses implementation, without API-key fallback.
    modelRuntime.registerNativeProvider({ ...provider, auth: { oauth: provider.auth.oauth } })
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

  const authSettings = SettingsManager.create(settings.botWorkdir, agentDir, {
    projectTrusted: false,
  })
  const login = oauth
    ? createOAuthLogin(modelRuntime, {
        getDeviceId: () => authSettings.getOrCreateDeviceId(),
      })
    : undefined
  return { modelRuntime, model, login }
}
