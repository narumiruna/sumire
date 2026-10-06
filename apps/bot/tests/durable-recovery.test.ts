import { fork } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Type } from "pi-durable-ai"
import {
  createRegistry,
  defineExtension,
  defineTool,
  type SubmissionId,
} from "@earendil-works/pi-durable"
import { describe, expect, it } from "vitest"
import { context, directory, fauxAssistantMessage, open } from "./durable-support.js"

async function crash(dir: string, mode: string): Promise<SubmissionId[]> {
  const child = fork(
    fileURLToPath(new URL("./fixtures/durable-crash.ts", import.meta.url)),
    [dir, mode],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  )
  let stderr = ""
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const closed = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  try {
    return await new Promise<SubmissionId[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Fixture timeout: ${stderr}`)), 15000)
      child.once("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once("exit", (code, signal) => {
        clearTimeout(timer)
        reject(new Error(`Unexpected fixture exit ${code}/${signal}: ${stderr}`))
      })
      child.on("message", (message) => {
        const value = message as { phase: string; ids: SubmissionId[] }
        if (value.phase !== "ready") return
        clearTimeout(timer)
        resolve(value.ids)
      })
    })
  } finally {
    child.kill("SIGKILL")
    await closed
  }
}

describe("Pi Durable recovery at process boundaries", () => {
  it("demonstrates that unsafe replay policy does not prohibit a fresh model-issued duplicate action", async () => {
    const dir = await directory()
    const ids = await crash(dir, "tool-unsafe")
    const { fauxToolCall } = await import("pi-durable-ai/providers/faux")
    const registry = createRegistry()
    registry.install(
      defineExtension({
        name: "test-tool",
        tools: [
          defineTool({
            name: "probe",
            description: "Synthetic external action",
            parameters: Type.Object({}),
            replay: "unsafe",
            execute: async () => {
              const { appendFile } = await import("node:fs/promises")
              await appendFile(path.join(dir, "calls.txt"), "call\n")
              return { content: [{ type: "text", text: "done" }] }
            },
          }),
        ],
      }),
    )
    const { runtime } = await open(
      dir,
      [
        fauxAssistantMessage(fauxToolCall("probe", {}, { id: "fresh-call" }), {
          stopReason: "toolUse",
        }),
        fauxAssistantMessage("done"),
      ],
      registry,
    )
    const id = ids[0]
    if (id === undefined) throw new Error("Missing fixture ID")
    const submission = await runtime.harness.submission(id, context)
    if (!submission) throw new Error("Missing admitted work")
    expect((await submission.wait(context)).status).toBe("done")
    expect((await readFile(path.join(dir, "calls.txt"), "utf8")).trim().split("\n")).toHaveLength(2)
  }, 20000)

  it.each(["admission", "generation", "queued"])(
    "resumes %s after SIGKILL without losing accepted work",
    async (mode) => {
      const dir = await directory()
      const ids = await crash(dir, mode)
      const { runtime } = await open(dir, [
        fauxAssistantMessage("recovered"),
        fauxAssistantMessage("follow"),
        fauxAssistantMessage("steer"),
      ])
      for (const id of ids) {
        const submission = await runtime.harness.submission(id, context)
        if (!submission) throw new Error("Missing persisted submission")
        expect((await submission.wait(context)).status).toBe("done")
      }
      const again = await runtime.submit("first", "first")
      expect(again.id).toBe(ids[0])
      expect(await runtime.answer(await again.wait(context))).toBe("recovered")
    },
    20000,
  )

  it.each(["safe", "unsafe"] as const)(
    "only replays an interrupted %s tool according to its declared policy",
    async (policy) => {
      const dir = await directory()
      const ids = await crash(dir, `tool-${policy}`)
      const registry = createRegistry()
      registry.install(
        defineExtension({
          name: "test-tool",
          tools: [
            defineTool({
              name: "probe",
              description: "Read-only test probe",
              parameters: Type.Object({}),
              replay: policy,
              execute: async () => {
                const { appendFile } = await import("node:fs/promises")
                await appendFile(path.join(dir, "calls.txt"), "call\n")
                return { content: [{ type: "text", text: "read" }] }
              },
            }),
          ],
        }),
      )
      const { runtime } = await open(dir, [fauxAssistantMessage("continued")], registry)
      const id = ids[0]
      if (id === undefined) throw new Error("Missing fixture ID")
      const submission = await runtime.harness.submission(id, context)
      if (!submission) throw new Error("Missing persisted submission")
      expect((await submission.wait(context)).status).toBe("done")
      expect((await readFile(path.join(dir, "calls.txt"), "utf8")).trim().split("\n")).toHaveLength(
        policy === "safe" ? 2 : 1,
      )
      const entries = await (await runtime.conversation()).entries({}, 50, undefined, context)
      const tool = entries.items.find((entry) => entry.kind === "pi.tool-result")?.model?.[0]
      expect(tool?.role).toBe("toolResult")
      if (tool?.role === "toolResult") expect(tool.isError).toBe(policy === "unsafe")
    },
    20000,
  )

  it("withdraws interrupted and queued work before resume without calling the replacement provider", async () => {
    const dir = await directory()
    const ids = await crash(dir, "queued")
    const { runtime, faux } = await open(dir)
    await runtime.cancel()
    for (const id of ids.slice(0, 3)) {
      const submission = await runtime.harness.submission(id, context)
      if (!submission) throw new Error("Missing persisted submission")
      expect((await submission.wait(context)).status).toBe("unanswered")
    }
    expect(faux.state.callCount).toBe(0)
  }, 20000)
})
