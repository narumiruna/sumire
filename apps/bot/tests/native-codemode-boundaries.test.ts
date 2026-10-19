import { readFile, rm } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { awaitWithContext, BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import { defineExtension, wrapTool } from "@earendil-works/pi-durable"
import { CodemodeStoreDoc } from "@earendil-works/pi-durable/codemode"
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DurableSession } from "../src/agent/durable-session.js"
import { currentConversation } from "./helpers/durable-session.js"
import { createPiFixture, toolResultText } from "./helpers/pi-fixture.js"

const fixtures: Awaited<ReturnType<typeof createPiFixture>>[] = []
const outputDirectories = new Set<string>()
afterEach(async () => {
  vi.restoreAllMocks()
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
  for (const directory of outputDirectories) await rm(directory, { recursive: true, force: true })
  outputDirectories.clear()
})

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function setup() {
  const fixture = await createPiFixture({ botCodemodeTimeoutSeconds: 5 })
  fixtures.push(fixture)
  return fixture
}

async function scriptTask(session: DurableSession) {
  const inspection = await session.harness.inspect(context)
  const task = inspection.tasks.find(
    ({ record }) => record.memos?.["sumire.codemode-policy.v1"] !== undefined,
  )?.record
  if (!task) throw new Error("Missing native codemode task")
  const policy = task.memos?.["sumire.codemode-policy.v1"] as { deadline: number }
  expect(Number.isFinite(policy.deadline)).toBe(true)
  return { task, deadline: policy.deadline }
}

function codemodeResults(session: DurableSession) {
  return session.messages.filter(
    (message) => message.role === "toolResult" && message.toolName === "codemode",
  )
}

describe("native codemode commit boundaries", () => {
  it("rejects success when spill formatting crosses the host deadline without changing the native store", async () => {
    const fixture = await setup()
    const session = await fixture.createSession()
    const conversation = await currentConversation(session)
    await conversation.commit(async (tx) => {
      ;(await tx.doc(CodemodeStoreDoc, conversation.id)).values = { existing: "preserved" }
    }, context)
    const before = await session.harness.snapshot(CodemodeStoreDoc, conversation.id, context)
    const writeFile = NodeExecutionEnv.prototype.writeFile
    let spillDeadline: number | undefined
    const spill = vi
      .spyOn(NodeExecutionEnv.prototype, "writeFile")
      .mockImplementation(async function (this: NodeExecutionEnv, file, content, writeContext) {
        if (
          path.basename(file) !== "output.txt" ||
          !path.basename(path.dirname(file)).startsWith("pi-codemode-")
        )
          return writeFile.call(this, file, content, writeContext)
        outputDirectories.add(path.dirname(file))
        const { deadline } = await scriptTask(session)
        spillDeadline = deadline
        // The native formatter spills only after the VM returns. Include its return value in the full output.
        expect(String(content)).toContain("returned42")
        expect(Date.now()).toBeLessThan(deadline)
        const written = await writeFile.call(this, file, content, writeContext)
        expect(written.ok).toBe(true)
        await delay(Math.max(0, deadline - Date.now()) + 100)
        return written
      })
    const result = await fixture.script(
      session,
      `// @options: {"timeout_ms": 120000, "max_output_tokens": 20}
store("existing", "must not commit");
store("newValue", 42);
text("spill ".repeat(2000));
return "returned42";`,
    )
    expect(spill).toHaveBeenCalledOnce()
    expect(spillDeadline).toBeDefined()
    expect(Date.now()).toBeGreaterThan(spillDeadline as number)
    expect(result.isError).toBe(true)
    expect(toolResultText(result)).toContain("host deadline")
    expect(await session.harness.snapshot(CodemodeStoreDoc, conversation.id, context)).toEqual(
      before,
    )
  }, 15_000)

  it("recovers committed native success after expiry when the outer ToolTask has not settled", async () => {
    const fixture = await setup()
    const session = await fixture.createSession()
    const conversation = await currentConversation(session)
    const codemode = session.registry
      .snapshot()
      .tools()
      .find(({ tool }) => tool.name === "codemode")?.tool
    if (!codemode) throw new Error("Missing native codemode registration")
    const gate = deferred()
    const nativeReturned = vi.fn()
    session.registry.install(
      defineExtension({
        name: "test-native-success-boundary",
        wraps: [
          wrapTool(codemode, (tool) => ({
            ...tool,
            async execute(args, api, executionContext) {
              const result = await tool.execute(args, api, executionContext)
              nativeReturned(result)
              // Native result and store are durable, but the outer tool result is not yet admitted.
              await awaitWithContext(gate.promise, executionContext)
              return result
            },
          })),
        ],
      }),
    )
    fixture.enqueue("codemode", {
      code: `// @options: {"timeout_ms": 120000}
await tools.bash({ command: "printf 'once\\n' >> success-effect.txt" });
store("answer", 42);
return "returned42";`,
    })
    const delivery = { sourceMessageId: 71, statusMessageId: 72, mode: "default" as const }
    const running = session
      .prompt("native saved success input", { delivery })
      .catch(() => undefined)
    let reopened: DurableSession | undefined
    try {
      await vi.waitFor(() => expect(nativeReturned).toHaveBeenCalledOnce(), { timeout: 10_000 })
      expect(nativeReturned.mock.calls[0]?.[0]).toMatchObject({ isError: false })
      expect(JSON.stringify(nativeReturned.mock.calls[0]?.[0])).toContain("returned42")
      const { task, deadline } = await scriptTask(session)
      expect(task.state.status).toBe("running")
      expect(Date.now()).toBeLessThan(deadline)
      expect(await session.harness.snapshot(CodemodeStoreDoc, conversation.id, context)).toEqual({
        values: { answer: 42 },
      })
      expect(
        (await conversation.context(context)).entries
          .flatMap((entry) => entry.model ?? [])
          .filter((message) => message.role === "toolResult" && message.toolName === "codemode"),
      ).toHaveLength(0)
      expect(await readFile(path.join(fixture.root, "success-effect.txt"), "utf8")).toBe("once\n")
      expect(fixture.requests).toHaveLength(1)

      // Close, not abort: preserve both the task and the transport recovery intent.
      await session.dispose()
      await running
      await delay(Math.max(0, deadline - Date.now()) + 100)
      const factory = await fixture.createFactory()
      reopened = await factory.create(123)
      const pending = await scriptTask(reopened)
      expect(pending.task.id).toBe(task.id)
      expect(pending.task.state.status).toBe("pending")
      expect(pending.deadline).toBe(deadline)
      expect(Date.now()).toBeGreaterThan(deadline)
      expect(await reopened.hasPendingResponses()).toBe(true)
      const deliver = vi.fn(async () => {})
      await reopened.recoverPending(deliver)
      expect(deliver).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ text: "Offline fixture completed." }),
        delivery,
      )
      const results = codemodeResults(reopened)
      expect(results).toHaveLength(1)
      const result = results[0]
      if (result?.role !== "toolResult") throw new Error("Missing recovered codemode result")
      expect(result.isError).toBe(false)
      expect(toolResultText(result)).toContain("returned42")
      expect(await reopened.harness.snapshot(CodemodeStoreDoc, conversation.id, context)).toEqual({
        values: { answer: 42 },
      })
      expect(await readFile(path.join(fixture.root, "success-effect.txt"), "utf8")).toBe("once\n")
      expect(reopened.messages.filter((message) => message.role === "user")).toHaveLength(1)
      expect(fixture.requests).toHaveLength(2)
      expect(
        fixture.requests[1]?.messages.filter((message) => message.role === "user"),
      ).toHaveLength(1)
    } finally {
      await session.dispose()
      gate.resolve()
      await running
      await reopened?.dispose()
    }
  }, 20_000)
})
