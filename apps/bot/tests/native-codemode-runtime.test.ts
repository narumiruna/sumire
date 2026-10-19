import { spawn } from "node:child_process"
import { once } from "node:events"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DurableSession } from "../src/agent/durable/session.js"
import { createPiFixture, toolResultText } from "./helpers/pi-fixture.js"

const fixtures: Awaited<ReturnType<typeof createPiFixture>>[] = []
async function setup(timeoutSeconds: number) {
  const fixture = await createPiFixture({ botCodemodeTimeoutSeconds: timeoutSeconds })
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
})

function startProcess(fixture: Awaited<ReturnType<typeof createPiFixture>>) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      new URL("./fixtures/native-codemode-crash.mjs", import.meta.url).pathname,
      fixture.root,
      fixture.endpoint,
      String(fixture.settings.botCodemodeTimeoutSeconds),
    ],
    { stdio: "pipe" },
  )
  let stderr = ""
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString()
  })
  const exited = once(child, "exit")
  return { child, exited, stderr: () => stderr }
}

function recoveryScript() {
  return `// @options: {"timeout_ms": 120000}
const completed = await tools.bash({ command: "printf 'completed\\n' >> completed.txt; printf committed", timeout: 60 });
let interrupted = false;
try {
  await tools.bash({ command: "printf 'started\\n' >> interrupted.txt; while [ ! -f release ]; do sleep 0.05; done", timeout: 60 });
} catch (error) {
  interrupted = true;
  text(error.message);
}
await tools.bash({ command: "printf 'continued\\n' >> continued.txt", timeout: 60 });
return { interrupted, completed: completed.output, continued: true };`
}

async function persistedBoundary(session: DurableSession) {
  const inspection = await session.harness.inspect(context)
  expect(inspection.scheduling).toBe("paused")
  const scripts = inspection.tasks.filter(
    ({ record }) => record.memos?.["sumire.codemode-policy.v1"] !== undefined,
  )
  expect(scripts).toHaveLength(1)
  const task = scripts[0]?.record
  if (!task) throw new Error("Missing persisted native codemode task")
  const policy = task.memos?.["sumire.codemode-policy.v1"] as { deadline: number }
  expect(Number.isFinite(policy.deadline)).toBe(true)
  const nested = await session.harness.commit(async (tx) => {
    const tasks = await tx.scanTasks({ conversationId: task.conversationId }, 100)
    return tasks.items.filter((candidate) => candidate.owner === task.id)
  }, context)
  // Starting the second call requires the first result to pass the native journal boundary.
  expect(nested.map((child) => child.state.status)).toEqual(["terminal", "pending"])
  return policy.deadline
}

function codemodeResult(session: DurableSession) {
  const results = session.messages.filter(
    (message) => message.role === "toolResult" && message.toolName === "codemode",
  )
  expect(results).toHaveLength(1)
  const result = results[0]
  if (result?.role !== "toolResult") throw new Error("Missing recovered native codemode result")
  return result
}

async function assertEffects(root: string) {
  expect(await readFile(path.join(root, "completed.txt"), "utf8")).toBe("completed\n")
  expect(await readFile(path.join(root, "interrupted.txt"), "utf8")).toBe("started\n")
}

describe("native codemode process recovery", () => {
  it.each(["SIGKILL", "SIGTERM"] as const)(
    "resumes the journal after %s without repeating completed or interrupted unsafe effects",
    async (signal) => {
      const fixture = await setup(30)
      fixture.enqueue("codemode", { code: recoveryScript() })
      const process = startProcess(fixture)
      try {
        await vi.waitFor(
          async () => {
            expect(process.child.exitCode, process.stderr()).toBeNull()
            await assertEffects(fixture.root)
          },
          { timeout: 10_000 },
        )
        expect(process.child.kill(signal)).toBe(true)
        await process.exited
        if (signal === "SIGTERM") expect(process.child.exitCode, process.stderr()).toBe(0)
        else expect(process.child.signalCode).toBe("SIGKILL")
        // An unsafe replay would now finish, rather than block on the old gate.
        await writeFile(path.join(fixture.root, "release"), "released")
        const session = await fixture.createSession()
        expect(await persistedBoundary(session)).toBeGreaterThan(Date.now())
        const deliver = vi.fn(async () => {})
        await session.recoverPending(deliver)
        expect(deliver).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ text: "Offline fixture completed." }),
          { sourceMessageId: 71, statusMessageId: 72, mode: "default" },
        )
        await assertEffects(fixture.root)
        expect(await readFile(path.join(fixture.root, "continued.txt"), "utf8")).toBe("continued\n")
        const result = codemodeResult(session)
        expect(result.isError).toBe(false)
        expect(toolResultText(result)).toContain('"interrupted":true')
        expect(toolResultText(result)).toContain('"completed":"committed"')
        expect(toolResultText(result)).toContain('"continued":true')
        expect(result.details).toMatchObject({
          calls: [
            { id: 1, name: "bash", status: "ok" },
            { id: 2, name: "bash", status: "error" },
            { id: 3, name: "bash", status: "ok" },
          ],
        })
        expect(session.messages.filter((message) => message.role === "user")).toHaveLength(1)
        expect(fixture.requests).toHaveLength(2)
      } finally {
        if (process.child.exitCode === null && process.child.signalCode === null)
          process.child.kill("SIGKILL")
        await process.exited
        await writeFile(path.join(fixture.root, "release"), "released")
      }
    },
    30_000,
  )

  it.each(["SIGKILL", "SIGTERM"] as const)(
    "keeps the absolute host deadline after %s and blocks new child effects when it expires",
    async (signal) => {
      const fixture = await setup(10)
      fixture.enqueue("codemode", { code: recoveryScript() })
      const process = startProcess(fixture)
      try {
        await vi.waitFor(
          async () => {
            expect(process.child.exitCode, process.stderr()).toBeNull()
            await assertEffects(fixture.root)
          },
          { timeout: 10_000 },
        )
        expect(process.child.kill(signal)).toBe(true)
        await process.exited
        if (signal === "SIGTERM") expect(process.child.exitCode, process.stderr()).toBe(0)
        else expect(process.child.signalCode).toBe("SIGKILL")
        await writeFile(path.join(fixture.root, "release"), "released")
        const session = await fixture.createSession()
        const deadline = await persistedBoundary(session)
        // Wait for the recorded deadline, not a delay measured from process startup.
        await delay(Math.max(0, deadline - Date.now()) + 100)
        expect(Date.now()).toBeGreaterThan(deadline)
        const deliver = vi.fn(async () => {})
        await session.recoverPending(deliver)
        expect(deliver).toHaveBeenCalledOnce()
        await assertEffects(fixture.root)
        await expect(
          readFile(path.join(fixture.root, "continued.txt"), "utf8"),
        ).rejects.toMatchObject({
          code: "ENOENT",
        })
        const result = codemodeResult(session)
        expect(result.isError).toBe(true)
        expect(toolResultText(result)).toContain("host deadline")
        expect(session.messages.filter((message) => message.role === "user")).toHaveLength(1)
        expect(fixture.requests).toHaveLength(2)
      } finally {
        if (process.child.exitCode === null && process.child.signalCode === null)
          process.child.kill("SIGKILL")
        await process.exited
        await writeFile(path.join(fixture.root, "release"), "released")
      }
    },
    30_000,
  )
})
