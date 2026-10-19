import path from "node:path"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { loadSettings } from "../../src/config/settings.ts"
import { createTestSessionFactory } from "../helpers/session-factory.ts"

const [root, endpoint, timeoutSeconds] = process.argv.slice(2)
const settings = {
  ...loadSettings({ BOT_ADMIN_ID: "7" }, root),
  botAgentMaxAttempts: 1,
  botCodemodeTimeoutSeconds: Number(timeoutSeconds),
}
const logger = { debug() {}, info() {}, warn() {}, error() {} }
const modelRuntime = await ModelRuntime.create({
  authPath: path.join(root, "native-crash-auth.json"),
  modelsPath: null,
  modelsStorePath: path.join(root, "native-crash-models.json"),
  refreshOnCreate: false,
})
modelRuntime.registerProvider("openai", {
  baseUrl: endpoint,
  api: "openai-completions",
  apiKey: "offline-native-crash-fixture-key",
  models: [
    {
      id: "gpt-6.1-sol",
      name: "Offline native crash fixture",
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 100_000,
      maxTokens: 20_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    },
  ],
})
const factory = await createTestSessionFactory(settings, logger, undefined, modelRuntime)
const session = await factory.create(123)
let stopping
process.once("SIGTERM", () => {
  // Close Harness without aborting the submission, as on service shutdown.
  stopping = session.dispose().then(() => process.exit(0))
})
await session
  .prompt("native codemode crash input", {
    delivery: { sourceMessageId: 71, statusMessageId: 72, mode: "default" },
  })
  .catch((error) => {
    if (!stopping) throw error
  })
if (stopping) await stopping
else throw new Error("Native crash fixture must stop while a nested tool is in progress")
