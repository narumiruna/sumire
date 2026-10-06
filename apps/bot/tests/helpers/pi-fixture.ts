import assert from "node:assert/strict"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { type AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent"

import { createPiSessionFactory } from "../../src/agent/pi-session-factory.js"
import { loadSettings } from "../../src/config/settings.js"
import type { Logger } from "../../src/logging.js"

interface CompletionRequest {
  model: string
  tools: Array<{ type: string; function: { name: string; parameters: Record<string, unknown> } }>
  messages: Array<{ role: string; content: unknown }>
}

type Reply = { tool: string; args: unknown } | { text: string }

/** A local fixture speaks the real Chat Completions wire contract, without calling a model. */
export async function createPiFixture(environment: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "sumire-codemode-test-"))
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
  await cp(path.join(repositoryRoot, "instructions"), path.join(root, "instructions"), {
    recursive: true,
  })
  const replies: Reply[] = []
  const requests: CompletionRequest[] = []
  const requestErrors: unknown[] = []
  let callId = 0
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions")
      let body = ""
      for await (const chunk of request) body += chunk
      const payload = JSON.parse(body) as CompletionRequest
      requests.push(payload)
      const reply = replies.shift()
      assert.ok(reply, "Unexpected model request")
      const id = `fixture-${++callId}`
      const chunk = (delta: unknown, finishReason: string | null = null) => ({
        id,
        object: "chat.completion.chunk",
        created: 1,
        model: payload.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })
      response.writeHead(200, { "content-type": "text/event-stream" })
      const emit = (data: unknown) => response.write(`data: ${JSON.stringify(data)}\n\n`)
      emit(chunk({ role: "assistant" }))
      if ("tool" in reply) {
        emit(
          chunk({
            tool_calls: [
              {
                index: 0,
                id: `call-${callId}`,
                type: "function",
                function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
              },
            ],
          }),
        )
        emit(chunk({}, "tool_calls"))
      } else {
        emit(chunk({ content: reply.text }))
        emit(chunk({}, "stop"))
      }
      response.end("data: [DONE]\n\n")
    } catch (error) {
      requestErrors.push(error)
      response.writeHead(500)
      response.end("Invalid offline fixture request")
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  const settings = {
    ...loadSettings(
      {
        BOT_WHITELIST: "123,456,-100",
        BOT_CODEMODE_ENABLED: "true",
        BOT_CHANNEL_IMAGE_INPUT_ENABLED: "true",
        ...environment,
      },
      root,
    ),
    botAgentMaxAttempts: 1,
  }
  const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} }
  const sessions = new Set<AgentSession>()
  try {
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(root, "fixture-auth.json"),
      modelsPath: null,
      modelsStorePath: path.join(root, "fixture-models-store.json"),
      refreshOnCreate: false,
    })
    modelRuntime.registerProvider("openai", {
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      api: "openai-completions",
      apiKey: "offline-fixture-key",
      models: [
        {
          id: "gpt-5.6-luna",
          name: "Offline fixture",
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          reasoning: false,
          input: ["text", "image"],
          contextWindow: 100_000,
          maxTokens: 20_000,
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        },
      ],
    })
    const factory = await createPiSessionFactory(settings, logger, undefined, modelRuntime)
    const createSession = async (chatId = 123) => {
      const session = await factory.create(chatId)
      sessions.add(session)
      return session
    }
    const enqueue = (tool: string, args: unknown, finalAnswer = true) => {
      replies.push({ tool, args })
      if (finalAnswer) replies.push({ text: "Offline fixture completed." })
    }
    const call = async (session: AgentSession, tool: string, args: unknown) => {
      enqueue(tool, args)
      await session.prompt("Execute the queued offline fixture.")
      const result = session.messages
        .filter((message) => message.role === "toolResult" && message.toolName === tool)
        .at(-1)
      assert.ok(result?.role === "toolResult")
      assert.equal(replies.length, 0)
      return result
    }
    return {
      root,
      settings,
      logger,
      requests,
      enqueue,
      createSession,
      createFactory: (enabled: boolean) =>
        createPiSessionFactory(
          { ...settings, botCodemodeEnabled: enabled },
          logger,
          undefined,
          modelRuntime,
        ),
      call,
      script: (session: AgentSession, code: string) => call(session, "codemode", { code }),
      async cleanup() {
        for (const session of sessions) {
          await session.abort()
          session.dispose()
        }
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
        await rm(root, { recursive: true, force: true })
        assert.deepEqual(requestErrors, [])
        assert.equal(replies.length, 0)
      },
    }
  } catch (error) {
    server.close()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

export function toolResultText(result: {
  content: Array<{ type: string; text?: string }>
}): string {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
}
