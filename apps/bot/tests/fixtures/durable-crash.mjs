import path from "node:path"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { createPiSessionFactory } from "../../src/agent/pi-session-factory.ts"
import { loadSettings } from "../../src/config/settings.ts"

const [root, endpoint, mcpConfig] = process.argv.slice(2)
const settings = loadSettings(
  {
    OPENAI_API_KEY: "offline-crash-fixture-key",
    OPENAI_BASE_URL: endpoint,
    OPENAI_MODEL: "fixture-model",
    BOT_WHITELIST: "123,456,-100",
    BOT_CODEMODE_ENABLED: "true",
    ...(mcpConfig ? { BOT_MCP_ENABLED: "true", BOT_MCP_CONFIG_PATH: mcpConfig } : {}),
  },
  root,
)
const logger = { debug() {}, info() {}, warn() {}, error() {} }
const modelRuntime = await ModelRuntime.create({
  authPath: path.join(root, "crash-auth.json"),
  modelsPath: null,
  modelsStorePath: path.join(root, "crash-models.json"),
  refreshOnCreate: false,
})
modelRuntime.registerProvider("openai", {
  baseUrl: endpoint,
  api: "openai-completions",
  apiKey: "offline-crash-fixture-key",
  models: [
    {
      id: "gpt-5.6-luna",
      name: "Offline crash fixture",
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 100_000,
      maxTokens: 20_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    },
  ],
})
const factory = await createPiSessionFactory(settings, logger, undefined, modelRuntime)
const session = await factory.create(123)
let stopping
if (mcpConfig)
  process.once("SIGTERM", () => {
    stopping = session.dispose().then(() => process.exit(0))
  })
await session
  .prompt("process crash input", {
    delivery: { sourceMessageId: 71, statusMessageId: 72, mode: "default" },
  })
  .catch((error) => {
    if (!stopping) throw error
  })
if (stopping) await stopping
else throw new Error("Crash fixture must be killed while the request is in progress")
