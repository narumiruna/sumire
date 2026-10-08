import { existsSync } from "node:fs"
import { cp, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DurableSession } from "../src/agent/durable-session.js"

import { createPiSessionFactory } from "../src/agent/pi-session-factory.js"
import { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { loadSettings } from "../src/config/settings.js"
import type { Logger } from "../src/logging.js"
import { appendMessage, currentConversation } from "./helpers/durable-session.js"

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const instructions = fileURLToPath(new URL("../../../instructions", import.meta.url))

function assistant(session: DurableSession): Extract<AgentMessage, { role: "assistant" }> {
  if (!session.model) throw new Error("Missing fixture model")
  return {
    role: "assistant",
    content: [{ type: "text", text: "fixture answer" }],
    api: session.model.api,
    provider: session.model.provider,
    model: session.model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  }
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "sumire-settings-persistence-"))
  await cp(instructions, path.join(root, "instructions"), { recursive: true })
  await writeFile(path.join(root, "mcp.json"), JSON.stringify({ mcpServers: {} }))
  const settings = loadSettings({ BOT_WHITELIST: "7" }, root)
  const factory = await createPiSessionFactory(settings, logger)
  const session = await factory.create(7)
  const registry = new ChatSessionRegistry(async () => session, settings.botSessionLogDir, logger, {
    replyTreeEnabled: true,
  })
  await registry.getModelSettings(7)
  return { settings, registry, session }
}

describe("durable chat model settings persistence", () => {
  beforeEach(() => vi.stubEnv("OPENAI_API_KEY", "fixture-key"))
  afterEach(() => vi.unstubAllEnvs())

  it.each([
    { name: "model and high thinking", changeModel: true, thinkingLevel: "high" },
    { name: "thinking only", changeModel: false, thinkingLevel: "high" },
    { name: "model and explicit off", changeModel: true, thinkingLevel: "off" },
    { name: "unchanged settings", changeModel: false, thinkingLevel: "off" },
  ] as const)(
    "keeps $name across older replies and restart",
    async ({ changeModel, thinkingLevel }) => {
      const { settings, registry, session } = await setup()
      const initialModel = session.model
      const alternative = session.modelRuntime
        .getModels("openai")
        .find(
          (model) =>
            model.id !== initialModel?.id &&
            (thinkingLevel === "off" ? !model.reasoning : model.reasoning),
        )
      if (!initialModel || !alternative) throw new Error("Missing fixture models")
      try {
        // Make the destination branch disagree except in the unchanged-settings case.
        const initialThinking = thinkingLevel === "off" && changeModel ? "high" : "off"
        if (initialThinking === "high") await registry.setThinkingLevel(7, "high")
        await appendMessage(session, {
          role: "user",
          content: "root",
          timestamp: Date.now(),
        })
        const rootAnswer = await appendMessage(session, assistant(session))
        await session.navigateTree(rootAnswer)
        await registry.recordDelivery(
          7,
          { sessionId: session.sessionId, entryId: rootAnswer, generation: 0 },
          [100],
        )

        const selectedModel = changeModel ? alternative : initialModel
        if (changeModel) await registry.setModel(7, `${selectedModel.provider}/${selectedModel.id}`)
        await registry.setThinkingLevel(7, thinkingLevel)
        await appendMessage(session, {
          role: "user",
          content: "abandoned later turn",
          timestamp: Date.now(),
        })
        await appendMessage(session, assistant(session))

        // Exercise durable forks and persisted model configuration, without calling a provider.
        const prompt = vi.spyOn(session, "prompt").mockImplementation(async (text) => {
          expect(session.model).toBe(selectedModel)
          expect(session.thinkingLevel).toBe(thinkingLevel)
          await appendMessage(session, {
            role: "user",
            content: text,
            timestamp: Date.now(),
          })
          return { text: "" }
        })
        await registry.submit(7, "reply to root", { replyToBotMessageId: 100 })
        expect(prompt).toHaveBeenCalledExactlyOnceWith(
          "reply to root",
          expect.objectContaining({ onAccepted: undefined }),
        )
        expect(await (await currentConversation(session)).agent(context)).toMatchObject({
          model: { provider: selectedModel.provider, modelId: selectedModel.id },
          thinkingLevel,
        })

        await registry.dispose()

        const resumed = await (await createPiSessionFactory(settings, logger)).create(7)
        try {
          expect(resumed.model).toMatchObject({
            provider: selectedModel.provider,
            id: selectedModel.id,
          })
          expect(resumed.thinkingLevel).toBe(thinkingLevel)
          const history = JSON.stringify(resumed.messages)
          expect(history).toContain("reply to root")
          expect(history).not.toContain("abandoned later turn")
        } finally {
          await resumed.dispose()
        }
      } finally {
        await registry.dispose()
      }
    },
  )

  it("leaves setup-only changes in Pi memory until the first conversation message", async () => {
    const { settings, registry, session } = await setup()
    const initialModel = session.model
    const alternative = session.modelRuntime
      .getModels("openai")
      .find((model) => model.reasoning && model.id !== initialModel?.id)
    if (!initialModel || !alternative || !session.sessionFile)
      throw new Error("Missing fixture state")
    try {
      await registry.setModel(7, `${alternative.provider}/${alternative.id}`)
      await registry.setThinkingLevel(7, "high")
      expect(session.messages).toEqual([])
      expect(session.model).toBe(alternative)
      expect(session.thinkingLevel).toBe("high")
      expect(await (await currentConversation(session)).agent(context)).toMatchObject({
        model: { provider: initialModel.provider, modelId: initialModel.id },
        thinkingLevel: "off",
      })
      expect(existsSync(session.sessionFile)).toBe(true)
      await registry.dispose()

      const restartedFactory = await createPiSessionFactory(settings, logger)
      const fresh = await restartedFactory.create(7)
      try {
        expect(fresh.model).toMatchObject({ provider: initialModel.provider, id: initialModel.id })
        expect(fresh.thinkingLevel).toBe("off")
      } finally {
        await fresh.dispose()
      }
    } finally {
      await registry.dispose()
    }
  })
})
