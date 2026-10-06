import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// Exercise the production build without Vitest, provider credentials, or Telegram polling.
const appRoot = process.env.SUMIRE_APP_ROOT ?? fileURLToPath(new URL("../..", import.meta.url))
const projectRoot = path.resolve(appRoot, "../..")
if (process.env.SUMIRE_SMOKE_PRODUCTION === "true") {
  assert.equal(process.platform, "linux")
  assert.equal(process.arch, "x64")
  assert.notEqual(process.getuid(), 0)
  assert.equal(existsSync(path.join(projectRoot, "node_modules/vitest")), false)
}
const { createPiSessionFactory } = await import(
  pathToFileURL(path.join(appRoot, "dist/agent/pi-session-factory.js"))
)
const { loadSettings } = await import(pathToFileURL(path.join(appRoot, "dist/config/settings.js")))
const root = await mkdtemp(path.join(tmpdir(), "sumire-codemode-smoke-"))
const replies = []
let callId = 0
const errors = []
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/v1/chat/completions")
    let body = ""
    for await (const chunk of request) body += chunk
    const payload = JSON.parse(body)
    assert.equal(payload.tools.find((tool) => tool.function?.name === "codemode")?.type, "function")
    const reply = replies.shift()
    assert.ok(reply, "Unexpected fixture request")
    const id = `smoke-${++callId}`
    const emit = (delta, finishReason = null) =>
      response.write(
        `data: ${JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created: 1,
          model: "smoke-model",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`,
      )
    response.writeHead(200, { "content-type": "text/event-stream" })
    emit({ role: "assistant" })
    if (reply.tool) {
      emit({
        tool_calls: [
          {
            index: 0,
            id: `call-${callId}`,
            type: "function",
            function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
          },
        ],
      })
      emit({}, "tool_calls")
    } else {
      emit({ content: "Offline smoke completed." })
      emit({}, "stop")
    }
    response.end("data: [DONE]\n\n")
  } catch (error) {
    errors.push(error)
    response.writeHead(500)
    response.end("Invalid smoke fixture request")
  }
})
let session
try {
  await cp(path.join(projectRoot, "instructions"), path.join(root, "instructions"), {
    recursive: true,
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const settings = {
    ...loadSettings(
      {
        OPENAI_API_KEY: "offline-smoke-key",
        OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_MODEL: "smoke-model",
        BOT_WHITELIST: "123",
        BOT_CODEMODE_ENABLED: "true",
        BOT_CODEMODE_TIMEOUT_SECONDS: "1",
      },
      root,
    ),
    botAgentMaxAttempts: 1,
  }
  const logger = { debug() {}, info() {}, warn() {}, error() {} }
  const factory = await createPiSessionFactory(settings, logger)
  session = await factory.create(123)
  const call = async (tool, args) => {
    replies.push({ tool, args }, { text: true })
    await session.prompt("Execute the queued offline smoke fixture.")
    const result = session.messages
      .filter((message) => message.role === "toolResult" && message.toolName === tool)
      .at(-1)
    assert.ok(result)
    assert.equal(replies.length, 0)
    return result
  }
  const progress = await call("update_progress", { steps: [{ text: "smoke", status: "pending" }] })
  assert.equal(progress.isError, false)
  const result = await call("codemode", {
    code: `
await tools.write({ path: 'smoke.txt', content: 'native-worker-ok' });
const results = await Promise.all([tools.read({ path: 'smoke.txt' }), tools.bash({ command: 'printf native-bash-ok', timeout: 5 })]);
text(results); store('marker', 'persisted');`,
  })
  assert.equal(result.isError, false)
  assert.ok(JSON.stringify(result.content).includes("native-worker-ok"))
  assert.ok(JSON.stringify(result.content).includes("native-bash-ok"))
  session.dispose()
  session = await factory.create(123)
  assert.deepEqual((await call("codemode", { code: "return load('marker')" })).content.at(-1), {
    type: "text",
    text: "persisted",
  })
  const timeout = await call("codemode", {
    code: '// @options: {"timeout_ms": 60000}\nwhile (true) {}',
  })
  assert.equal(timeout.isError, true)
  assert.ok(JSON.stringify(timeout.content).includes("1000ms host deadline"))
  assert.equal((await call("codemode", { code: "return 'recovered'" })).isError, false)
  assert.deepEqual(errors, [])
  console.log(
    "PASS: production Pi worker/WASM, native tools, direct progress, persistence, host deadline and recovery; no external model or Telegram requests.",
  )
} finally {
  if (session) {
    await session.abort()
    session.dispose()
  }
  await new Promise((resolve) => server.close(resolve))
  await rm(root, { recursive: true, force: true })
}
