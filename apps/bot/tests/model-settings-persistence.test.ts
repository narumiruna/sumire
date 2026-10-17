import { existsSync } from "node:fs"
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { inherited } from "@narumitw/sumire-policy"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPolicyApplier } from "../src/admin/application.js"
import { ProviderAdmin } from "../src/admin/providers.js"
import type { DurableSession } from "../src/agent/durable-session.js"
import { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { loadSettings } from "../src/config/settings.js"
import type { Logger } from "../src/logging.js"
import { appendMessage, currentConversation } from "./helpers/durable-session.js"
import { createTestSessionFactory as createPiSessionFactory } from "./helpers/session-factory.js"

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const instructions = fileURLToPath(new URL("../../../instructions", import.meta.url))
const roots: string[] = []

function assistant(session: DurableSession): Extract<AgentMessage, { role: "assistant" }> {
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
  roots.push(root)
  await cp(instructions, path.join(root, "instructions"), { recursive: true })
  await writeFile(path.join(root, "mcp.json"), JSON.stringify({ mcpServers: {} }))
  const settings = loadSettings({ BOT_ADMIN_ID: "7" }, root)
  const factory = await createPiSessionFactory(settings, logger)
  const create = vi.fn((id: number) => factory.create(id))
  const registry = new ChatSessionRegistry(create, settings.botSessionLogDir, logger, {
    control: factory.control,
    replyTreeEnabled: true,
  })
  if (!factory.modelRuntime) throw new Error("Missing fixture runtime")
  const providers = new ProviderAdmin(factory.modelRuntime, factory.control)
  const apply = createPolicyApplier(factory.control, registry, providers)
  const open = async () => {
    await registry.appendPassiveContext(7, "fixture context")
    const result = create.mock.results.at(-1)
    if (result?.type !== "return") throw new Error("Missing fixture session")
    return result.value
  }
  return { settings, factory, registry, apply, open }
}

describe("administration model policy persistence", () => {
  beforeEach(() => vi.stubEnv("OPENAI_API_KEY", "fixture-key"))
  afterEach(async () => {
    vi.unstubAllEnvs()
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  })

  it.each([
    { name: "model and high thinking", changeModel: true, thinkingLevel: "high" },
    { name: "thinking only", changeModel: false, thinkingLevel: "high" },
    { name: "model and explicit off", changeModel: true, thinkingLevel: "off" },
    { name: "unchanged settings", changeModel: false, thinkingLevel: "low" },
  ] as const)(
    "keeps $name across policy application, older replies, reset, and restart",
    async ({ changeModel, thinkingLevel }) => {
      const { settings, factory, registry, apply, open } = await setup()
      try {
        const original = await open()
        const initialModel = original.model
        const alternative = original.modelRuntime
          .getModels("openai")
          .find(
            (model) =>
              model.id !== initialModel.id &&
              (thinkingLevel === "off" ? !model.reasoning : model.reasoning),
          )
        if (!alternative) throw new Error("Missing fixture model")
        await original.setThinkingLevel(thinkingLevel === "off" && changeModel ? "high" : "low")
        await appendMessage(original, { role: "user", content: "root", timestamp: Date.now() })
        const rootAnswer = await appendMessage(original, assistant(original))
        await original.navigateTree(rootAnswer)
        await registry.recordDelivery(
          7,
          { sessionId: original.sessionId, entryId: rootAnswer, generation: 0 },
          [100],
        )

        const selectedModel = changeModel ? alternative : initialModel
        const state = factory.control.snapshot()
        state.policy.chats["7"] = {
          ...inherited,
          enabled: true,
          model: `${selectedModel.provider}/${selectedModel.id}`,
          thinking: thinkingLevel,
        }
        factory.control.save(state.policy, state.revision, "7")
        await apply()
        const session = await open()
        expect(session).not.toBe(original)
        await appendMessage(session, {
          role: "user",
          content: "abandoned later turn",
          timestamp: Date.now(),
        })
        await appendMessage(session, assistant(session))
        const prompt = vi.spyOn(session, "prompt").mockImplementation(async (text) => {
          expect(session.model).toMatchObject({
            provider: selectedModel.provider,
            id: selectedModel.id,
          })
          expect(session.thinkingLevel).toBe(thinkingLevel)
          await appendMessage(session, { role: "user", content: text, timestamp: Date.now() })
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
          expect(JSON.stringify(resumed.messages)).toContain("reply to root")
          expect(JSON.stringify(resumed.messages)).not.toContain("abandoned later turn")
        } finally {
          await resumed.dispose()
        }
        const resetRegistry = new ChatSessionRegistry(
          factory.create,
          settings.botSessionLogDir,
          logger,
          {
            control: factory.control,
          },
        )
        await resetRegistry.reset(7)
        await resetRegistry.dispose()
        const fresh = await factory.create(7)
        try {
          expect(fresh.model).toMatchObject({
            provider: selectedModel.provider,
            id: selectedModel.id,
          })
          expect(fresh.thinkingLevel).toBe(thinkingLevel)
          expect(fresh.messages).toEqual([])
        } finally {
          await fresh.dispose()
        }
      } finally {
        await registry.dispose()
      }
    },
  )

  it("applies setup-only policy choices before the first conversation message", async () => {
    const { factory, registry, apply } = await setup()
    try {
      const initial = await factory.create(7)
      const alternative = initial.modelRuntime
        .getModels("openai")
        .find((model) => model.reasoning && model.id !== initial.model.id)
      await initial.dispose()
      if (!alternative) throw new Error("Missing fixture model")
      const state = factory.control.snapshot()
      state.policy.chats["7"] = {
        ...inherited,
        enabled: true,
        model: `${alternative.provider}/${alternative.id}`,
        thinking: "high",
      }
      factory.control.save(state.policy, state.revision, "7")
      await apply()
      const session = await factory.create(7)
      try {
        expect(session.messages).toEqual([])
        expect(session.model).toMatchObject({ provider: alternative.provider, id: alternative.id })
        expect(session.thinkingLevel).toBe("high")
        expect(existsSync(session.sessionFile)).toBe(true)
      } finally {
        await session.dispose()
      }
    } finally {
      await registry.dispose()
    }
  })
})
