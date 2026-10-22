import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { inherited } from "@narumitw/sumire-policy"
import { afterEach, expect, it, vi } from "vitest"
import { createPolicyApplier } from "../src/admin/application.js"
import { McpAdmin } from "../src/admin/mcp.js"
import type { DurableSession } from "../src/agent/durable/session.js"
import { createPiSessionFactory } from "../src/agent/pi-session-factory.js"
import { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { callDurableTool } from "./helpers/durable-session.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

async function setup(enabled = new Set<string>()) {
  const fixture = await createPiFixture()
  cleanups.push(() => fixture.cleanup())
  for (const name of ["alpha", "beta"]) {
    const directory = path.join(fixture.settings.botSkillsDir, name)
    await mkdir(directory, { recursive: true })
    await writeFile(
      path.join(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: Use ${name} for fixture tasks.\n---\nPrivate ${name} instructions.\n`,
    )
  }
  const store = fixture.factory.control
  const mcp = new McpAdmin(store, fixture.root)
  cleanups.push(() => mcp.close())
  const register = vi.spyOn(store, "registerSkills")
  const settings = { ...fixture.settings, botEnabledSkills: enabled }
  const factory = await createPiSessionFactory(
    settings,
    fixture.logger,
    { store, mcp },
    undefined,
    fixture.modelRuntime,
  )
  const sessions: DurableSession[] = []
  cleanups.push(async () => {
    for (const session of sessions) await session.dispose()
  })
  const create = async (id: number) => {
    const session = await factory.create(id)
    sessions.push(session)
    return session
  }
  const save = (update: (policy: ReturnType<typeof store.snapshot>["policy"]) => void) => {
    const state = store.snapshot()
    update(state.policy)
    store.save(state.policy, state.revision, "7")
    store.applied(store.snapshot().revision, true)
  }
  return { fixture, store, mcp, settings, factory, register, create, save }
}

it("discovers skill metadata with the configured filter and registers names once", async () => {
  const { factory, register, create } = await setup(new Set(["alpha", "not-installed"]))
  expect(factory.skills).toEqual([{ name: "alpha", description: "Use alpha for fixture tasks." }])
  expect(register).toHaveBeenCalledExactlyOnceWith(["alpha"])
  const first = await create(123)
  const second = await create(42)
  expect(first.systemPrompt).toContain("<name>alpha</name>")
  expect(first.systemPrompt).not.toContain("<name>beta</name>")
  expect(first.systemPrompt).not.toContain("<name>load-url-content</name>")
  expect(first.systemPrompt).not.toContain("Private alpha instructions.")
  expect(second.systemPrompt).toBe(first.systemPrompt)
  expect(register).toHaveBeenCalledTimes(1)
})

it.each([256, 257])("keeps startup available with a %i-character skill name", async (length) => {
  const fixture = await createPiFixture()
  cleanups.push(() => fixture.cleanup())
  const longName = "a".repeat(length)
  for (const [directoryName, name] of [
    ["valid", "valid"],
    ["long-name", longName],
  ] as const) {
    const directory = path.join(fixture.settings.botSkillsDir, directoryName)
    await mkdir(directory, { recursive: true })
    await writeFile(
      path.join(directory, "SKILL.md"),
      `---\nname: ${name}\ndescription: A fixture skill.\n---\nFixture instructions.\n`,
    )
  }
  const store = fixture.factory.control
  const mcp = new McpAdmin(store, fixture.root)
  cleanups.push(() => mcp.close())
  const warn = vi.spyOn(fixture.logger, "warn")
  const factory = await createPiSessionFactory(
    fixture.settings,
    fixture.logger,
    { store, mcp },
    undefined,
    fixture.modelRuntime,
  )
  expect(factory.skills).toContainEqual({ name: "valid", description: "A fixture skill." })
  expect(store.snapshot().policy.defaults.skills).toContain("valid")
  const session = await factory.create(123)
  cleanups.push(() => session.dispose())
  expect(session.systemPrompt).toContain("<name>valid</name>")
  const diagnostic = "Pi skill skipped: name is outside administration policy limits"
  if (length === 256) {
    expect(factory.skills?.map((skill) => skill.name)).toContain(longName)
    expect(store.snapshot().policy.skills).toContain(longName)
    expect(session.systemPrompt).toContain(`<name>${longName}</name>`)
    expect(warn).not.toHaveBeenCalledWith(diagnostic, expect.anything())
  } else {
    expect(factory.skills?.map((skill) => skill.name)).not.toContain(longName)
    expect(store.snapshot().policy.skills).not.toContain(longName)
    expect(session.systemPrompt).not.toContain(longName)
    expect(warn).toHaveBeenCalledWith(diagnostic, {
      path: path.join(fixture.settings.botSkillsDir, "long-name/SKILL.md"),
    })
  }
})

it("uses default and per-chat skill selections without changing tool permissions or file access", async () => {
  const { fixture, factory, create, save } = await setup()
  expect(factory.skills).toEqual(
    expect.arrayContaining([
      { name: "alpha", description: "Use alpha for fixture tasks." },
      { name: "beta", description: "Use beta for fixture tasks." },
      expect.objectContaining({ name: "load-url-content" }),
    ]),
  )
  expect(
    factory.skills?.every((skill) => Object.keys(skill).sort().join() === "description,name"),
  ).toBe(true)
  save((policy) => {
    policy.skills = ["alpha", "beta", "not-installed"]
    policy.defaults.skills = ["alpha"]
    policy.chats["123"] = { ...inherited, enabled: true, skills: ["beta"], tools: ["read"] }
    policy.chats["7"] = { ...inherited, enabled: true, skills: [] }
    policy.chats["8"] = { ...inherited, enabled: true, skills: ["not-installed"] }
  })
  const defaultSession = await create(42)
  const selectedSession = await create(123)
  const emptySession = await create(7)
  const unavailableSession = await create(8)
  expect(defaultSession.systemPrompt).toContain("<name>alpha</name>")
  expect(defaultSession.systemPrompt).not.toContain("<name>beta</name>")
  expect(selectedSession.systemPrompt).toContain("<name>beta</name>")
  expect(selectedSession.systemPrompt).not.toContain("<name>alpha</name>")
  expect(emptySession.systemPrompt).not.toContain("<available_skills>")
  expect(unavailableSession.systemPrompt).toBe(emptySession.systemPrompt)
  expect(selectedSession.getActiveToolNames()).toEqual(["read"])
  expect(emptySession.getActiveToolNames()).toContain("read_url_content")
  expect(selectedSession.systemPrompt).toContain(emptySession.systemPrompt)
  const result = await callDurableTool(selectedSession, "read", {
    path: path.join(fixture.settings.botSkillsDir, "alpha/SKILL.md"),
  })
  expect(result.isError).not.toBe(true)
  expect(JSON.stringify(result.content)).toContain("Private alpha instructions.")
  for (const session of [defaultSession, selectedSession, emptySession]) {
    fixture.enqueueAnswer()
    await session.prompt("Report the visible skills.")
    const systemMessages = fixture.requests
      .at(-1)
      ?.messages.filter((message) => message.role === "system")
    expect(JSON.stringify(systemMessages)).toContain(
      JSON.stringify(session.systemPrompt).slice(1, -1),
    )
    expect(JSON.stringify(systemMessages)).not.toContain("<name>not-installed</name>")
  }
})

it("applies skill settings changes to restored sessions without registering names again", async () => {
  const { fixture, factory, store, settings, mcp, register, save } = await setup()
  save((policy) => {
    policy.defaults.skills = ["alpha"]
  })
  const opened: DurableSession[] = []
  const registry = new ChatSessionRegistry(
    async (chatId) => {
      const session = await factory.create(chatId)
      opened.push(session)
      return session
    },
    settings.botSessionLogDir,
    fixture.logger,
    { control: store },
  )
  cleanups.push(() => registry.dispose())
  const apply = createPolicyApplier(store, registry, {
    validate: async () => {},
    install: () => {},
  })
  fixture.enqueueAnswer()
  await registry.submit(123, "First request")
  expect(opened[0]?.systemPrompt).toContain("<name>alpha</name>")
  const state = store.snapshot()
  state.policy.skills = ["beta"]
  state.policy.defaults.skills = ["beta"]
  store.save(state.policy, state.revision, "7")
  await apply()
  fixture.enqueueAnswer()
  await registry.submit(123, "Second request")
  expect(opened).toHaveLength(2)
  expect(opened[1]?.systemPrompt).toContain("<name>beta</name>")
  expect(opened[1]?.systemPrompt).not.toContain("<name>alpha</name>")
  expect(JSON.stringify(fixture.requests.at(-1)?.messages)).toContain(
    JSON.stringify(opened[1]?.systemPrompt).slice(1, -1),
  )
  expect(opened[1]?.getActiveToolNames()).toEqual(opened[0]?.getActiveToolNames())
  expect(register).toHaveBeenCalledTimes(1)
  const restarted = await createPiSessionFactory(
    settings,
    fixture.logger,
    { store, mcp },
    undefined,
    fixture.modelRuntime,
  )
  expect(store.snapshot().policy.skills).toEqual(["beta"])
  expect(store.snapshot().policy.defaults.skills).toEqual(["beta"])
  expect(restarted.skills).toEqual(factory.skills)
})
