import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { expect, it } from "vitest"
import { createPiFixture } from "./helpers/pi-fixture.js"

it("preserves Pi's default prompt and appends the bot template in model requests", async () => {
  const fixture = await createPiFixture()
  try {
    const template = await readFile(fixture.settings.botSystemPromptPath, "utf8")
    const soul = (await readFile(fixture.settings.botSoulPath, "utf8")).slice(
      0,
      fixture.settings.botSoulMaxChars,
    )
    const appended = template.replace("{{SOUL_SECTION}}", `## SOUL.md\n\n${soul}`).trim()
    // The renamed file is an addendum, not a replacement prompt discovered from SYSTEM.md.
    await writeFile(path.join(fixture.root, "instructions/SYSTEM.md"), "REPLACEMENT_SENTINEL")
    const session = await fixture.createSession()
    const preamble = "You are an expert coding assistant operating inside pi"
    expect(session.systemPrompt.startsWith(preamble)).toBe(true)
    expect(session.systemPrompt).toContain("<rules>")
    expect(session.systemPrompt).toContain("<docs>")
    expect(session.systemPrompt).toContain(`<addendum>\n${appended}\n</addendum>`)
    expect(session.systemPrompt.indexOf("<addendum>")).toBeGreaterThan(
      session.systemPrompt.indexOf("</docs>"),
    )
    expect(session.systemPrompt).not.toContain("REPLACEMENT_SENTINEL")
    expect(session.systemPrompt).not.toContain("{{SOUL_SECTION}}")

    fixture.enqueueAnswer()
    await session.prompt("Report your instructions.")
    const system = JSON.stringify(
      fixture.requests.at(-1)?.messages.filter((message) => message.role === "system"),
    )
    expect(system).toContain(preamble)
    expect(system).toContain(JSON.stringify(appended).slice(1, -1))
    expect(system).not.toContain("REPLACEMENT_SENTINEL")
  } finally {
    await fixture.cleanup()
  }
})
