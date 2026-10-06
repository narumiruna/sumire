import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { reconstructProgress } from "@narumitw/sumire-progress"
import { afterEach, describe, expect, it } from "vitest"

import { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { createPiFixture, toolResultText } from "./helpers/pi-fixture.js"

const fixtures: Awaited<ReturnType<typeof createPiFixture>>[] = []
async function setup(environment: Record<string, string> = {}) {
  const fixture = await createPiFixture(environment)
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
})

describe("codemode through Bot Pi sessions", () => {
  it("uses normal function calling, keeps direct tools and excludes model-only tools from discovery", async () => {
    const fixture = await setup()
    // A discovered filesystem extension must remain unloaded even with codemode enabled.
    const extensionDirectory = path.join(fixture.root, ".pi/extensions")
    await mkdir(extensionDirectory, { recursive: true })
    await writeFile(
      path.join(extensionDirectory, "untrusted.js"),
      "throw new Error('must not load')",
    )
    const session = await fixture.createSession()
    const result = await fixture.script(
      session,
      `return { models: typeof models, tools: ALL_TOOLS.map(tool => tool.name), progress: ALL_TOOLS.some(tool => tool.name === 'update_progress'), image: ALL_TOOLS.some(tool => tool.name === 'read_image') };`,
    )
    expect(result.isError).toBe(false)
    expect(toolResultText(result)).toContain('"models":"undefined"')
    expect(toolResultText(result)).toContain('"progress":false')
    expect(toolResultText(result)).toContain('"image":false')
    expect(toolResultText(result)).toContain('"load_public_url"')
    for (const name of ["update_progress", "read_image"]) {
      expect(session.getAllTools().find((tool) => tool.name === name)?.exposure).toBe("model-only")
      expect(fixture.requests[0]?.tools.some((tool) => tool.function.name === name)).toBe(true)
    }
    for (const name of ["read", "bash", "edit", "write"]) {
      expect(fixture.requests[0]?.tools.some((tool) => tool.function.name === name)).toBe(true)
    }
    expect(
      fixture.requests[0]?.tools.find((tool) => tool.function.name === "codemode"),
    ).toMatchObject({
      type: "function",
      function: { parameters: { properties: { code: { type: "string" } } } },
    })
    expect(session.getToolDefinition("tool_search")).toBeUndefined()
    expect(
      (await fixture.script(session, "await tools.update_progress({ steps: [] })")).isError,
    ).toBe(true)
    expect((await fixture.script(session, "await tools.read_image({})")).isError).toBe(true)
  })

  it("runs independent calls in parallel through validation and existing URL defenses", async () => {
    const fixture = await setup()
    const session = await fixture.createSession()
    const events: AgentSessionEvent[] = []
    let active = 0
    let maxActive = 0
    const unsubscribe = session.subscribe((event) => {
      events.push(event)
      if (
        event.type === "tool_execution_start" &&
        event.toolName === "bash" &&
        event.parentToolCallId
      )
        maxActive = Math.max(maxActive, ++active)
      if (
        event.type === "tool_execution_end" &&
        event.toolName === "bash" &&
        event.parentToolCallId
      )
        active--
    })
    const result = await fixture.script(
      session,
      `
await tools.write({ path: 'note.txt', content: 'before' });
await tools.edit({ path: 'note.txt', edits: [{ oldText: 'before', newText: 'after' }] });
const results = await Promise.allSettled([
  tools.read({ path: 'note.txt' }),
  tools.bash({ command: 'sleep 0.2; printf first', timeout: 5 }),
  tools.bash({ command: 'sleep 0.2; printf second', timeout: 5 }),
  tools.read({ path: 17 }),
  ...['http://127.0.0.1/', 'http://169.254.169.254/', 'http://[::1]/', 'https://user:pass@8.8.8.8/'].map(url => tools.load_public_url({ url }))
]);
text(results.map(result => result.status === 'fulfilled' ? { status: result.status, value: result.value } : { status: result.status, error: result.reason.message }));`,
    )
    unsubscribe()
    expect(result.isError).toBe(false)
    expect(toolResultText(result)).toContain('"value":"after"')
    expect(toolResultText(result)).toContain('"output":"first"')
    expect(toolResultText(result)).toContain('"output":"second"')
    expect(maxActive).toBe(2)
    const ends = events.filter(
      (event) => event.type === "tool_execution_end" && event.parentToolCallId,
    )
    expect(
      ends.filter((event) => event.type === "tool_execution_end" && event.isError),
    ).toHaveLength(5)
    expect(result.nestedCalls).toBeDefined()
    expect(await readFile(path.join(fixture.root, "note.txt"), "utf8")).toBe("after")
    expect(fixture.requests).toHaveLength(2) // unsafe URLs never reach this server
  })

  it("caps nested Bash, keeps partial output and completed side effects, and recovers on the next request", async () => {
    const fixture = await setup({ BOT_CODEMODE_TIMEOUT_SECONDS: "1" })
    const session = await fixture.createSession()
    const events: AgentSessionEvent[] = []
    session.subscribe((event) => events.push(event))
    const result = await fixture.script(
      session,
      `// @options: {"timeout_ms": 60000}
await tools.write({ path: 'completed.txt', content: 'not rolled back' });
text('partial output'); store('failed', true);
await tools.bash({ command: 'sleep 30', timeout: 60 });`,
    )
    expect(result.isError).toBe(true)
    expect(toolResultText(result)).toContain("partial output")
    expect(toolResultText(result)).toContain("1000ms host deadline")
    expect(await readFile(path.join(fixture.root, "completed.txt"), "utf8")).toBe("not rolled back")
    expect(
      events.some(
        (event) =>
          event.type === "tool_execution_end" &&
          event.toolName === "bash" &&
          event.isError &&
          event.parentToolCallId,
      ),
    ).toBe(true)
    const next = await fixture.script(
      session,
      "return { stored: load('failed') ?? null, recovered: true }",
    )
    expect(next.isError).toBe(false)
    expect(toolResultText(next)).toContain('"stored":null,"recovered":true')
  })

  it("preserves Pi output truncation and failed-script store semantics", async () => {
    const fixture = await setup()
    const session = await fixture.createSession()
    const failed = await fixture.script(
      session,
      "store('failed', true); text('partial'); throw new Error('fixture failure')",
    )
    expect(failed.isError).toBe(true)
    expect(toolResultText(failed)).toContain("partial")
    const output = await fixture.script(
      session,
      '// @options: {"max_output_tokens": 10}\ntext("x".repeat(5000));',
    )
    expect(output.isError).toBe(false)
    const fullOutputPath = (output.details as { fullOutputPath: string }).fullOutputPath
    expect(await readFile(fullOutputPath, "utf8")).toBe("x".repeat(5000))
    await rm(fullOutputPath)
    expect(
      toolResultText(await fixture.script(session, "return load('failed') ?? null")),
    ).toContain("null")
  })

  it("restores store and direct progress across reply-tree navigation and restart, isolates chats, and resumes when disabled", async () => {
    const fixture = await setup()
    const session = await fixture.createSession()
    const registry = new ChatSessionRegistry(
      async () => session,
      fixture.settings.botSessionLogDir,
      fixture.logger,
      { replyTreeEnabled: true },
    )
    try {
      const progress = [{ text: "branch A", status: "pending" }]
      expect((await fixture.call(session, "update_progress", { steps: progress })).isError).toBe(
        false,
      )
      fixture.enqueue("codemode", { code: "store('marker', 1)" })
      const first = await registry.submit(123, "branch A")
      expect(first.kind).toBe("completed")
      if (first.kind !== "completed") throw new Error("Missing checkpoint")
      await registry.recordDelivery(123, first.checkpoint, [101])
      await fixture.call(session, "update_progress", {
        steps: [{ text: "branch B", status: "completed" }],
      })
      fixture.enqueue("codemode", { code: "store('marker', 2)" })
      await registry.submit(123, "branch B")
      fixture.enqueue("codemode", { code: "return load('marker')" })
      await registry.submit(123, "reply to branch A", { replyToBotMessageId: 101 })
      const result = session.messages
        .filter((message) => message.role === "toolResult" && message.toolName === "codemode")
        .at(-1)
      if (result?.role !== "toolResult") throw new Error("Missing codemode result")
      expect(result.content).toContainEqual({ type: "text", text: "1" })
      expect(reconstructProgress(session.sessionManager.getBranch())).toEqual(progress)
    } finally {
      await registry.dispose()
    }
    const resumed = await fixture.createSession()
    expect((await fixture.script(resumed, "return load('marker')")).content).toContainEqual({
      type: "text",
      text: "1",
    })
    expect(reconstructProgress(resumed.sessionManager.getBranch())).toEqual([
      { text: "branch A", status: "pending" },
    ])
    expect((await fixture.call(resumed, "update_progress", { steps: [] })).isError).toBe(false)
    const other = await fixture.createSession(456)
    expect((await fixture.script(other, "return load('marker') ?? null")).content).toContainEqual({
      type: "text",
      text: "null",
    })
    expect((await fixture.script(other, "store('marker', 3)")).isError).toBe(false)
    expect((await fixture.script(resumed, "return load('marker')")).content).toContainEqual({
      type: "text",
      text: "1",
    })
    resumed.dispose()
    const disabledFactory = await fixture.createFactory(false)
    const disabled = await disabledFactory.create(123)
    try {
      expect(disabled.getActiveToolNames()).not.toContain("codemode")
      expect(disabled.getToolDefinition("codemode")).toBeUndefined()
      expect((await fixture.call(disabled, "update_progress", { steps: [] })).isError).toBe(false)
      expect(
        (
          await fixture.call(disabled, "bash", {
            command: "printf disabled-session-ok",
            timeout: 5,
          })
        ).isError,
      ).toBe(false)
    } finally {
      disabled.dispose()
    }
  })

  it.each(["cancel", "reset"] as const)(
    "%s cancels an in-flight script and allows a new submission",
    async (action) => {
      const fixture = await setup()
      let started = () => {}
      const bashStarted = new Promise<void>((resolve) => {
        started = resolve
      })
      const createdSessions: AgentSession[] = []
      const registry = new ChatSessionRegistry(
        async (chatId) => {
          const session = await fixture.createSession(chatId)
          createdSessions.push(session)
          session.subscribe((event) => {
            if (
              event.type === "tool_execution_start" &&
              event.toolName === "bash" &&
              event.parentToolCallId
            )
              started()
          })
          return session
        },
        fixture.settings.botSessionLogDir,
        fixture.logger,
      )
      try {
        fixture.enqueue(
          "codemode",
          {
            code: "store('cancelled', true); await tools.bash({ command: 'sleep 30', timeout: 60 })",
          },
          false,
        )
        const pending = registry.submit(123, "start script")
        await bashStarted
        await registry[action](123)
        expect((await pending).kind).not.toBe("completed")
        fixture.enqueue("codemode", { code: "return load('cancelled') ?? null" })
        expect((await registry.submit(123, "next submission")).kind).toBe("completed")
        expect(createdSessions).toHaveLength(action === "reset" ? 2 : 1)
        const result = createdSessions
          .at(-1)
          ?.messages.filter(
            (message) => message.role === "toolResult" && message.toolName === "codemode",
          )
          .at(-1)
        if (result?.role !== "toolResult") throw new Error("Missing recovery result")
        expect(result.isError).toBe(false)
        expect(result.content).toContainEqual({ type: "text", text: "null" })
      } finally {
        await registry.dispose()
      }
    },
  )
})
