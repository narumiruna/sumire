import { mkdtemp } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"

import { ChatSessionRegistry } from "../src/agent/session-registry.js"
import type { Logger } from "../src/logging.js"

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}

describe("pinned Pi passive-context behavior", () => {
  it("appends idle background context before the next user message", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sumire-passive-"))
    const manager = SessionManager.inMemory(root)
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } })
    const resourceLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir: path.join(root, "agent"),
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "test",
    })
    await resourceLoader.reload()
    const { session } = await createAgentSession({
      cwd: root,
      noTools: "all",
      resourceLoader,
      sessionManager: manager,
      settingsManager,
    })
    try {
      const registry = new ChatSessionRegistry(async () => session, root, logger)
      await registry.appendPassiveContext(1, "[群組旁聽訊息] Codex reset?")
      const beforeUser = manager.buildSessionContext().messages
      expect(beforeUser.at(-1)).toMatchObject({
        role: "custom",
        customType: "telegram-passive-context",
        content: "[群組旁聽訊息] Codex reset?",
      })
      manager.appendMessage({
        role: "user",
        content: "https://example.com/airbus",
        timestamp: Date.now(),
      })
      expect(manager.buildSessionContext().messages.at(-1)).toMatchObject({
        role: "user",
        content: "https://example.com/airbus",
      })
    } finally {
      session.dispose()
    }
  })

  it("sends passive context before the current URL to the model, unlike nextTurn", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sumire-passive-model-"))
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      response.writeHead(200, { "content-type": "text/event-stream" })
      response.end(
        'data: {"id":"test","object":"chat.completion.chunk","model":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      )
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing test server port")
    try {
      const runtime = await ModelRuntime.create({
        authPath: path.join(root, "auth.json"),
        modelsPath: null,
        modelsStorePath: path.join(root, "models.json"),
        refreshOnCreate: false,
      })
      runtime.registerProvider("passive-test", {
        name: "passive-test",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: "openai-completions",
        authHeader: true,
        models: [
          {
            id: "test",
            name: "test",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8_192,
            maxTokens: 1_024,
          },
        ],
      })
      await runtime.setRuntimeApiKey("passive-test", "local-test-key")
      const model = runtime.getModel("passive-test", "test")
      if (!model) throw new Error("Missing test model")
      for (const mode of ["nextTurn", "context"] as const) {
        const manager = SessionManager.inMemory(root)
        const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } })
        const resourceLoader = new DefaultResourceLoader({
          cwd: root,
          agentDir: path.join(root, "agent"),
          settingsManager,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          systemPrompt: "test",
        })
        await resourceLoader.reload()
        const { session } = await createAgentSession({
          cwd: root,
          noTools: "all",
          modelRuntime: runtime,
          model,
          resourceLoader,
          sessionManager: manager,
          settingsManager,
        })
        try {
          if (mode === "nextTurn") {
            await session.sendCustomMessage(
              { customType: "telegram-passive-context", content: "Codex reset?", display: false },
              { triggerTurn: false, deliverAs: "nextTurn" },
            )
          } else {
            await new ChatSessionRegistry(async () => session, root, logger).appendPassiveContext(
              1,
              "Codex reset?",
            )
          }
          await session.prompt("https://example.com/airbus")
        } finally {
          session.dispose()
        }
      }
      expect(requests).toHaveLength(2)
      expect(JSON.stringify(requests[0]?.messages.at(-1))).toContain("Codex reset?")
      expect(JSON.stringify(requests[1]?.messages.at(-2))).toContain("Codex reset?")
      expect(JSON.stringify(requests[1]?.messages.at(-1))).toContain("https://example.com/airbus")
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })
})
