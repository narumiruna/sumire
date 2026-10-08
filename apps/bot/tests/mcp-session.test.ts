import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createPiFixture, toolResultText } from "./helpers/pi-fixture.js"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function setup(exposure = "codemode", environment: Record<string, string> = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-mcp-session-"))
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
          exposure,
          env: { SECRET_KEY: "session-secret", ...environment },
        },
      },
    }),
  )
  const fixture = await createPiFixture({
    BOT_MCP_ENABLED: "true",
    BOT_MCP_CONFIG_PATH: config,
    BOT_CODEMODE_ENABLED: "false",
  })
  cleanups.push(() => fixture.cleanup())
  return { fixture, config, effects }
}

describe("MCP through durable sessions", () => {
  it("activates codemode for MCP, discovers tools and namespaces, and keeps model-only tools out of scripts", async () => {
    const { fixture } = await setup()
    const session = await fixture.createSession()
    expect(session.getActiveToolNames()).toContain("codemode")
    expect(session.getActiveToolNames()).not.toContain("mcp__fake__echo")
    const events: Array<{ type: string; parentToolCallId?: string }> = []
    session.subscribe((event) => events.push(event))
    const result = await fixture.script(
      session,
      'text(await searchTools("echo", { namespace: "fake" })); text(await describeNamespace("fake")); text(ALL_TOOLS); text(await tools.mcp__fake__echo({ returnSecret: true }));',
    )
    const text = toolResultText(result)
    expect(text).toContain("mcp__fake__echo")
    expect(text).toContain("Use echo for testing")
    expect(text).toContain("structuredContent")
    expect(text).toContain("[redacted]")
    expect(text).not.toContain("session-secret")
    expect(JSON.stringify(session.messages)).not.toContain("session-secret")
    expect(
      events.some((event) => event.type === "tool_execution_end" && event.parentToolCallId),
    ).toBe(true)
    const search = await fixture.script(
      session,
      'text(ALL_TOOLS.filter(t => ["read_image", "update_progress"].includes(t.name)));',
    )
    expect(toolResultText(search)).toContain("[]")
  })

  it("declares direct tools, preserves direct isError and dynamically withdraws declarations", async () => {
    const { fixture } = await setup("direct")
    const session = await fixture.createSession()
    expect(session.getActiveToolNames()).toContain("mcp__fake__echo")
    expect(await fixture.call(session, "mcp__fake__error", {})).toMatchObject({ isError: true })
    await fixture.call(session, "mcp__fake__change_tools", {})
    await vi.waitFor(() => expect(session.getActiveToolNames()).toContain("mcp__fake__new_tool"))
    expect(session.getActiveToolNames()).not.toContain("mcp__fake__echo")
    const result = await fixture.script(
      session,
      'text(await searchTools("new_tool", { namespace: "fake" }));',
    )
    expect(toolResultText(result)).toContain("mcp__fake__new_tool")
    expect(JSON.stringify(fixture.requests)).not.toContain("session-secret")
  })

  it("rejects a retained codemode handle after a same-name raw replacement", async () => {
    const { fixture, effects } = await setup("direct", { MCP_TEST_TOOLS: "a-b,change_tools" })
    const session = await fixture.createSession()
    const gate = path.join(path.dirname(effects), "registry-ready")
    const command = `while [ ! -f '${gate.replaceAll("'", "'\\''")}' ]; do sleep 0.01; done`
    const running = fixture.script(
      session,
      `const old = tools.mcp__fake__a_b; await tools.mcp__fake__change_tools({ names: ["a_b", "change_tools", "ready"] }); await tools.bash(${JSON.stringify({ command })}); try { await old({}); text("unexpected success"); } catch (error) { text(error.message); }`,
    )
    let result: Awaited<typeof running>
    try {
      await vi.waitFor(() => expect(session.getActiveToolNames()).toContain("mcp__fake__ready"), {
        timeout: 5000,
      })
      await writeFile(gate, "ready")
      result = await running
    } finally {
      await writeFile(gate, "ready")
      await running.catch(() => {})
    }
    expect(toolResultText(result)).toContain("Tool selection is stale")
    await expect(readFile(effects, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    const fresh = await fixture.script(session, "text(await tools.mcp__fake__a_b({}));")
    expect(fresh).toMatchObject({ isError: false })
    expect(await readFile(effects, "utf8")).toBe("replacement\n")
  })

  it("keeps MCP resources unavailable and respects hidden exposure", async () => {
    const { fixture } = await setup("hidden")
    const session = await fixture.createSession()
    const result = await fixture.script(
      session,
      'text(await searchTools("echo", { namespace: "fake" })); text(ALL_TOOLS.filter(t => t.name.includes("mcp_resource")));',
    )
    expect(toolResultText(result)).toContain("[]")
    expect(session.getActiveToolNames().some((name) => name.startsWith("mcp__"))).toBe(false)
  })

  it("keeps chat registries and process homes isolated", async () => {
    const { fixture } = await setup("direct")
    const first = await fixture.createSession(123)
    const second = await fixture.createSession(456)
    await fixture.call(first, "mcp__fake__change_tools", {})
    await vi.waitFor(() => expect(first.getActiveToolNames()).not.toContain("mcp__fake__echo"))
    expect(second.getActiveToolNames()).toContain("mcp__fake__echo")
    await first.dispose()
    expect(await fixture.call(second, "mcp__fake__echo", {})).toMatchObject({ isError: false })
  })

  it.each([
    ["direct", "SIGKILL"],
    ["codemode", "SIGKILL"],
    ["direct", "SIGTERM"],
    ["codemode", "SIGTERM"],
  ] as const)(
    "does not replay an interrupted %s MCP side effect after %s",
    async (exposure, signal) => {
      const { fixture, config, effects } = await setup(exposure)
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          new URL("./fixtures/durable-crash.mjs", import.meta.url).pathname,
          fixture.root,
          fixture.endpoint,
          config,
        ],
        { stdio: "pipe" },
      )
      let stderr = ""
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString()
      })
      const exited = once(child, "exit")
      fixture.enqueue(
        exposure === "direct" ? "mcp__fake__hold" : "codemode",
        exposure === "direct" ? {} : { code: "await tools.mcp__fake__hold({});" },
      )
      try {
        await vi.waitFor(
          async () => {
            expect(child.exitCode, stderr).toBeNull()
            expect(await readFile(effects, "utf8")).toBe("called\n")
          },
          { timeout: 5000 },
        )
        const mcpDirectory = path.join(fixture.settings.botSessionLogDir, "123", "durable", "mcp")
        const oldHomes = (await readdir(mcpDirectory)).filter((name) => name.startsWith("process-"))
        expect(oldHomes).toHaveLength(1)
        const results = path.join(mcpDirectory, "results")
        await mkdir(results, { recursive: true })
        await writeFile(path.join(results, "preserved.txt"), "preserved result")
        child.kill(signal)
        await exited
        if (signal === "SIGTERM") expect(child.exitCode, stderr).toBe(0)
        const session = await fixture.createSession()
        const homes = (await readdir(mcpDirectory)).filter((name) => name.startsWith("process-"))
        expect(homes).toHaveLength(1)
        expect(homes).not.toContain(oldHomes[0])
        expect(await readFile(path.join(results, "preserved.txt"), "utf8")).toBe("preserved result")
        const delivered = vi.fn(async () => {})
        await session.recoverPending(delivered)
        expect(delivered).toHaveBeenCalledOnce()
        expect(await readFile(effects, "utf8")).toBe("called\n")
        expect(JSON.stringify(session.messages)).toMatch(/interrupted|Interrupted/)
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
        await exited
      }
    },
  )
})
