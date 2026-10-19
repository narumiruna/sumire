import { afterEach, describe, expect, it } from "vitest"
import { createDurableCodemode } from "../src/agent/durable-codemode.js"
import { createPiFixture, toolResultText } from "./helpers/pi-fixture.js"

const fixtures: Awaited<ReturnType<typeof createPiFixture>>[] = []
async function setup(timeoutSeconds: number) {
  const fixture = await createPiFixture({ botCodemodeTimeoutSeconds: timeoutSeconds })
  fixtures.push(fixture)
  return { fixture, session: await fixture.createSession() }
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
})

describe("native codemode host policy", () => {
  it("registers native metadata without opening a Harness or starting a VM", () => {
    const extension = createDurableCodemode(
      300_000,
      () => {
        throw new Error("not open")
      },
      () => ({}),
      () => [],
      async () => {},
      () => {},
    )
    expect(extension.tools).toHaveLength(1)
    expect(extension.tools?.[0]).toMatchObject({
      name: "codemode",
      replay: "safe",
      callers: ["model"],
      constrainedSampling: { type: "grammar" },
    })
    expect(extension.tasks).toHaveLength(1)
  })

  it.each(["", '// @options: {"timeout_ms": 60000}\n'])(
    "bounds CPU scripts even with options %s and recovers on the next call",
    async (options) => {
      const { fixture, session } = await setup(0.3)
      const result = await fixture.script(session, `${options}text('partial'); while (true) {}`)
      expect(result.isError).toBe(true)
      expect(toolResultText(result)).toContain("300ms host deadline")
      expect(toolResultText(await fixture.script(session, 'return "next script"'))).toContain(
        "next script",
      )
    },
  )

  it("honors a shorter script limit and exposes no model or host globals", async () => {
    const { fixture, session } = await setup(5)
    const result = await fixture.script(
      session,
      '// @options: {"timeout_ms": 100}\nwhile (true) {}',
    )
    expect(result.isError).toBe(true)
    expect(toolResultText(result)).not.toContain("host deadline")
    const globals = await fixture.script(
      session,
      "return [typeof models, typeof process, typeof fetch, typeof setTimeout]",
    )
    expect(toolResultText(globals)).toContain('["undefined","undefined","undefined","undefined"]')
  })

  it.each([
    ["return 1", false],
    ["const =", true],
  ] as const)("settles %s and releases the VM before another call", async (code, isError) => {
    const { fixture, session } = await setup(5)
    const result = await fixture.script(session, code)
    expect(Boolean(result.isError)).toBe(isError)
    expect((await fixture.script(session, "return 2")).isError).toBe(false)
  })
})
