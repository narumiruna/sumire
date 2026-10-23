import { appendFile } from "node:fs/promises"
import path from "node:path"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { IMAGE_ENDPOINT } from "@narumitw/sumire-imagegen"
import { PNG } from "../../../../packages/imagegen/tests/fixtures.ts"
import { loadSettings } from "../../src/config/settings.ts"
import { createTestSessionFactory } from "../helpers/session-factory.ts"

const [root, endpoint] = process.argv.slice(2)
if (!root || !endpoint) throw new Error("Missing crash fixture arguments")
const settings = loadSettings({ BOT_ADMIN_ID: "7" }, root)
const runtime = await ModelRuntime.create({
  authPath: path.join(root, "crash-image-auth.json"),
  modelsPath: null,
  modelsStorePath: path.join(root, "crash-image-models.json"),
  refreshOnCreate: false,
})
runtime.registerProvider("openai", {
  baseUrl: endpoint,
  api: "openai-completions",
  apiKey: "offline-fixture-key",
  models: [
    {
      id: "gpt-6.1-sol",
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
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url")
const token = `${encode({ alg: "RS256" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })}.${encode("synthetic")}`
const usingOAuth = runtime.isUsingOAuth.bind(runtime)
const status = runtime.getProviderAuthStatus.bind(runtime)
const check = runtime.checkAuth.bind(runtime)
const auth = runtime.getAuth.bind(runtime)
// Synthetic public auth seam; this process never reads or refreshes a real Codex credential.
runtime.isUsingOAuth = (id) => id === "openai-codex" || usingOAuth(id)
runtime.getProviderAuthStatus = (id) =>
  id === "openai-codex" ? { configured: true, source: "stored" } : status(id)
runtime.checkAuth = (id, options) =>
  id === "openai-codex" ? Promise.resolve({ type: "oauth" }) : check(id, options)
runtime.getAuth = (model, options) =>
  model === "openai-codex" ? Promise.resolve({ auth: { apiKey: token } }) : auth(model, options)
const originalFetch = globalThis.fetch
const counter = path.join(root, "imagegen-crash-requests.txt")
globalThis.fetch = async (input, options) => {
  if (String(input) !== IMAGE_ENDPOINT) return originalFetch(input, options)
  await appendFile(counter, "1\n")
  return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString("base64") }] }), {
    headers: { "content-type": "application/json" },
  })
}
const logger = { debug() {}, info() {}, warn() {}, error() {} }
const factory = await createTestSessionFactory(settings, logger, undefined, runtime)
const session = await factory.create(123)
const answer = await session.prompt("Generate the crash fixture image", {
  delivery: { sourceMessageId: 71, statusMessageId: 72, mode: "default" },
})
if (answer.media?.length !== 1) throw new Error("Crash fixture image was not committed")
process.send?.({ type: "image-committed" })
// The parent kills this process after the durable receipt and original file are committed.
setInterval(() => {}, 1000)
