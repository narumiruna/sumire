import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { awaitWithContext, BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import { defineExtension, GenerationTask, hook, ToolTask } from "@earendil-works/pi-durable"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createToolSelectionExtension, ToolSelectionDoc } from "../src/agent/durable/codemode.js"
import type { DurableSession } from "../src/agent/durable/session.js"
import { callDurableTool, currentConversation } from "./helpers/durable-session.js"
import { createPiFixture, toolResultText } from "./helpers/pi-fixture.js"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function setup(rawName: string, overrides: Parameters<typeof createPiFixture>[0] = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-native-selection-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const config = path.join(directory, "mcp.json")
  const effects = path.join(directory, "effects.txt")
  await writeFile(
    config,
    JSON.stringify({
      mcpServers: {
        fake: {
          command: process.execPath,
          args: [new URL("./fixtures/mcp-server.mjs", import.meta.url).pathname, effects],
          exposure: "direct",
          env: { MCP_TEST_TOOLS: `${rawName},change_tools` },
        },
      },
    }),
  )
  const fixture = await createPiFixture({ botMcpConfigPath: config, ...overrides })
  cleanups.push(() => fixture.cleanup())
  return { fixture, effects }
}

async function requestOwner(session: DurableSession) {
  const inspection = await session.harness.inspect(context)
  const task = inspection.tasks.find(({ record }) => record.kind === "pi.generation")?.record
  if (!task) throw new Error("Missing model request owner and selection memo")
  const selected = (await session.harness.snapshot(ToolSelectionDoc, task.id, context))?.generations
  if (!selected) throw new Error("Missing prepared request selection")
  expect(selected.mcp__fake__a_b).toEqual(expect.any(String))
  return { task, selected }
}

describe("native direct tool request selection", () => {
  it.each([false, true])(
    "replaces selection for a newly prepared retry (restart: %s)",
    async (restart) => {
      const { fixture, effects } = await setup("a-b", {
        botAgentMaxAttempts: 2,
        botAgentRetryBaseDelaySeconds: 1,
      })
      const session = await fixture.createSession()
      const releaseFirst = fixture.pauseNextRequest()
      fixture.enqueueFailure(503)
      fixture.enqueue("mcp__fake__a_b", {})
      const running = session
        .prompt("retry selection input", {
          delivery: { sourceMessageId: 71, mode: "default" },
        })
        .catch(() => undefined)
      let releaseRetry = () => {}
      let reopened: DurableSession | undefined
      let recovery: Promise<void> | undefined
      try {
        await vi.waitFor(() => expect(fixture.requests).toHaveLength(1))
        const original = (await requestOwner(session)).selected.mcp__fake__a_b
        expect(
          (
            await callDurableTool(session, "codemode", {
              code: 'await tools.mcp__fake__change_tools({ names: ["a_b", "change_tools", "ready"] });',
            })
          ).isError,
        ).toBe(false)
        await vi.waitFor(() => expect(session.getActiveToolNames()).toContain("mcp__fake__ready"))
        releaseRetry = fixture.pauseNextRequest()
        releaseFirst()
        if (restart) {
          await vi.waitFor(async () => {
            const owner = (await requestOwner(session)).task
            expect(owner.state).toMatchObject({ checkpoint: { phase: "retry" } })
          })
          await session.dispose()
          await running
          reopened = await (await fixture.createFactory()).create(123)
          recovery = reopened.recoverPending(async () => {})
        }
        await vi.waitFor(() => expect(fixture.requests).toHaveLength(2), { timeout: 5000 })
        const active = reopened ?? session
        const schema = active.registry
          .snapshot()
          .tools()
          .find(({ tool }) => tool.name === "mcp__fake__a_b")?.tool.parameters
        const current =
          schema && "x-sumire-tool-generation" in schema
            ? schema["x-sumire-tool-generation"]
            : undefined
        const selected = (await requestOwner(active)).selected.mcp__fake__a_b
        expect(selected).toBe(current)
        expect(selected).not.toBe(original)
        expect(JSON.stringify(fixture.requests[1])).not.toContain("x-sumire-tool-generation")
        releaseRetry()
        if (recovery) await recovery
        else await running
        const result = active.messages.findLast(
          (message) => message.role === "toolResult" && message.toolName === "mcp__fake__a_b",
        )
        expect(result).toMatchObject({ isError: false })
        if (restart)
          await expect(readFile(effects, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
        else expect(await readFile(effects, "utf8")).toBe("replacement\n")
        expect(fixture.requests).toHaveLength(3)
      } finally {
        releaseFirst()
        releaseRetry()
        await running
        await recovery?.catch(() => {})
        await reopened?.dispose()
      }
    },
    20_000,
  )

  it.each([false, true])(
    "binds the prepared declaration before request hooks (restart: %s)",
    async (restart) => {
      const { fixture, effects } = await setup("a-b")
      const session = await fixture.createSession()
      const schema = session.registry
        .snapshot()
        .tools()
        .find(({ tool }) => tool.name === "mcp__fake__a_b")?.tool.parameters
      const original =
        schema && "x-sumire-tool-generation" in schema
          ? schema["x-sumire-tool-generation"]
          : undefined
      expect(original).toEqual(expect.any(String))
      const beforeSelection = deferred()
      const prepared = vi.fn()
      const selection = createToolSelectionExtension(() => session.harness)
      session.registry.install(
        defineExtension({
          ...selection,
          hooks: [
            hook(GenerationTask, {
              async beforeRequest(_request, _api, executionContext) {
                prepared()
                await awaitWithContext(beforeSelection.promise, executionContext)
              },
            }),
            ...(selection.hooks ?? []),
          ],
        }),
      )
      const releaseRequest = fixture.pauseNextRequest()
      fixture.enqueue("mcp__fake__a_b", {})
      const running = session
        .prompt("prepared selection input", {
          delivery: { sourceMessageId: 71, mode: "default" },
        })
        .catch(() => undefined)
      let reopened: DurableSession | undefined
      let recovery: Promise<void> | undefined
      try {
        await vi.waitFor(() => expect(prepared).toHaveBeenCalledOnce())
        expect(fixture.requests).toHaveLength(0)
        expect(
          (
            await callDurableTool(session, "codemode", {
              code: 'await tools.mcp__fake__change_tools({ names: ["a_b", "change_tools", "ready"] });',
            })
          ).isError,
        ).toBe(false)
        await vi.waitFor(() => expect(session.getActiveToolNames()).toContain("mcp__fake__ready"))
        if (restart) {
          await session.dispose()
          await running
          reopened = await (await fixture.createFactory()).create(123)
          recovery = reopened.recoverPending(async () => {})
        } else beforeSelection.resolve()
        await vi.waitFor(() => expect(fixture.requests).toHaveLength(1), { timeout: 5000 })
        expect((await requestOwner(reopened ?? session)).selected.mcp__fake__a_b).toBe(original)
        expect(JSON.stringify(fixture.requests[0])).not.toContain("x-sumire-tool-generation")
        releaseRequest()
        if (recovery) await recovery
        else await running
        const result = (reopened ?? session).messages.findLast(
          (message) => message.role === "toolResult" && message.toolName === "mcp__fake__a_b",
        )
        expect(result).toMatchObject({ isError: true })
        if (result?.role !== "toolResult") throw new Error("Missing prepared-selection result")
        expect(toolResultText(result)).toContain("Tool selection is stale")
        await expect(readFile(effects, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
      } finally {
        beforeSelection.resolve()
        releaseRequest()
        await running
        await recovery?.catch(() => {})
        await reopened?.dispose()
      }
    },
    20_000,
  )

  it("rejects a same-name raw MCP replacement made after the model request was sent", async () => {
    const { fixture, effects } = await setup("a-b")
    const session = await fixture.createSession()
    const release = fixture.pauseNextRequest()
    const running = fixture.call(session, "mcp__fake__a_b", {})
    // Observe rejection at once if setup or registry replacement fails before the request is released.
    running.catch(() => {})
    try {
      await vi.waitFor(() => expect(fixture.requests).toHaveLength(1), { timeout: 5000 })
      expect(
        fixture.requests[0]?.tools.some((tool) => tool.function.name === "mcp__fake__a_b"),
      ).toBe(true)
      const owner = await requestOwner(session)
      // An independent durable codemode task changes the live registry while the real model response is gated.
      const changed = await callDurableTool(session, "codemode", {
        code: 'await tools.mcp__fake__change_tools({ names: ["a_b", "change_tools", "ready"] });',
      })
      expect(changed.isError).toBe(false)
      await vi.waitFor(() => expect(session.getActiveToolNames()).toContain("mcp__fake__ready"), {
        timeout: 5000,
      })
      expect((await requestOwner(session)).selected).toEqual(owner.selected)
      release()
      const result = await running
      expect(result.isError).toBe(true)
      expect(toolResultText(result)).toContain("Tool selection is stale")
      const conversation = await currentConversation(session)
      const tasks = await conversation.commit(
        (tx) => tx.scanTasks({ conversationId: conversation.id }, 100),
        context,
      )
      const direct = tasks.items.find((task) => {
        const input = task.input as { kind?: string; callId?: string }
        return (
          task.kind === "pi.tool" && input.kind === "model" && input.callId === result.toolCallId
        )
      })
      // The failure must come from the request's real generation owner, not a synthetic ownerless call.
      expect(direct?.owner).toBe(owner.task.id)
      await expect(readFile(effects, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
      expect(fixture.requests).toHaveLength(2)
      const fresh = await fixture.call(session, "mcp__fake__a_b", {})
      expect(fresh.isError).toBe(false)
      expect(await readFile(effects, "utf8")).toBe("replacement\n")
    } finally {
      release()
      await running.catch(() => {})
    }
  }, 20_000)

  it("keeps a pending direct call bound to its original request selection after restart", async () => {
    const { fixture, effects } = await setup("a_b")
    const session = await fixture.createSession()
    const gate = deferred()
    const admitted = vi.fn()
    session.registry.install(
      defineExtension({
        name: "test-pending-direct-boundary",
        hooks: [
          hook(ToolTask, {
            async beforeTool(call, api, executionContext) {
              if (call.name !== "mcp__fake__a_b") return
              admitted(api.taskId)
              // Pause before execution intent: an unsafe tool must not be reported as interrupted instead of guarded.
              await awaitWithContext(gate.promise, executionContext)
            },
          }),
        ],
      }),
    )
    fixture.enqueue("mcp__fake__a_b", {})
    const delivery = { sourceMessageId: 71, statusMessageId: 72, mode: "default" as const }
    const running = session
      .prompt("pending direct selection input", { delivery })
      .catch(() => undefined)
    let reopened: DurableSession | undefined
    try {
      await vi.waitFor(() => expect(admitted).toHaveBeenCalledOnce(), { timeout: 5000 })
      const owner = await requestOwner(session)
      const conversation = await currentConversation(session)
      const directId = admitted.mock.calls[0]?.[0]
      const direct = await conversation.commit((tx) => tx.task(directId), context)
      expect(direct?.owner).toBe(owner.task.id)
      expect(direct?.state).toMatchObject({ status: "running", checkpoint: { phase: "call" } })
      await expect(readFile(effects, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
      await session.dispose()
      await running
      const factory = await fixture.createFactory()
      reopened = await factory.create(123)
      const restored = await requestOwner(reopened)
      expect(restored.task.id).toBe(owner.task.id)
      expect(restored.selected).toEqual(owner.selected)
      const pending = await reopened.harness.commit((tx) => tx.task(directId), context)
      expect(pending?.state).toMatchObject({ status: "pending", checkpoint: { phase: "call" } })
      const deliver = vi.fn(async () => {})
      await reopened.recoverPending(deliver)
      expect(deliver).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: "Offline fixture completed." }),
        delivery,
      )
      const results = reopened.messages.filter(
        (message) => message.role === "toolResult" && message.toolName === "mcp__fake__a_b",
      )
      expect(results).toHaveLength(1)
      const result = results[0]
      if (result?.role !== "toolResult") throw new Error("Missing restored direct tool result")
      expect(result.isError).toBe(true)
      expect(toolResultText(result)).toContain("Tool selection is stale")
      await expect(readFile(effects, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
      expect(reopened.messages.filter((message) => message.role === "user")).toHaveLength(1)
      expect(fixture.requests).toHaveLength(2)
      expect((await fixture.call(reopened, "mcp__fake__a_b", {})).isError).toBe(false)
      expect(await readFile(effects, "utf8")).toBe("replacement\n")
    } finally {
      await session.dispose()
      gate.resolve()
      await running
      await reopened?.dispose()
    }
  }, 20_000)
})
