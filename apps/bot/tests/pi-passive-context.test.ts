import { afterEach, describe, expect, it, vi } from "vitest"

import { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

const fixtures: Awaited<ReturnType<typeof createPiFixture>>[] = []
const setup = async () => {
  const fixture = await createPiFixture()
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
})

describe("durable passive-context behavior", () => {
  it("puts background context before the addressed question, including on a restored reply branch", async () => {
    const fixture = await setup()
    const session = await fixture.createSession()
    const registry = new ChatSessionRegistry(
      async () => session,
      fixture.settings.botSessionLogDir,
      fixture.logger,
      { replyTreeEnabled: true },
    )
    try {
      fixture.enqueueAnswer("First answer")
      const first = await registry.submit(123, "first question")
      if (first.kind !== "completed") throw new Error("Missing first answer")
      await registry.recordDelivery(123, first.checkpoint, [100])
      fixture.enqueueAnswer("Abandoned answer")
      await registry.submit(123, "abandoned second question")
      await registry.appendPassiveContext(123, "[群組旁聽訊息] Codex reset?")
      fixture.enqueueAnswer("Current answer")
      await registry.submit(123, "https://example.com/airbus", { replyToBotMessageId: 100 })
      const context = JSON.stringify(fixture.requests.at(-1)?.messages)
      expect(context).not.toContain("abandoned second question")
      expect(context.indexOf("Codex reset?")).toBeLessThan(
        context.lastIndexOf("https://example.com/airbus"),
      )
      expect(context).toContain("Codex reset?")
      expect(JSON.stringify(fixture.requests.at(-1)?.messages.at(-1))).toContain(
        "https://example.com/airbus",
      )
    } finally {
      await registry.dispose()
    }
  })

  it("does not steer an unfinished model request with passive group input", async () => {
    const fixture = await setup()
    const session = await fixture.createSession()
    const registry = new ChatSessionRegistry(
      async () => session,
      fixture.settings.botSessionLogDir,
      fixture.logger,
    )
    const release = fixture.pauseNextRequest()
    fixture.enqueueAnswer("First answer")
    const running = registry.submit(123, "https://example.com/airbus")
    try {
      await vi.waitFor(() => expect(fixture.requests).toHaveLength(1))
      await registry.appendPassiveContext(123, "passive background only")
      expect(JSON.stringify(fixture.requests[0]?.messages)).not.toContain("passive background only")
      expect(
        session.sessionManager.getBranch().some((entry) => entry.type === "custom_message"),
      ).toBe(false)
      release()
      await running
      const branch = session.sessionManager.getBranch()
      const answer = branch.findIndex(
        (entry) => entry.type === "message" && entry.message.role === "assistant",
      )
      const passive = branch.findIndex((entry) => entry.type === "custom_message")
      expect(passive).toBeGreaterThan(answer)
      fixture.enqueueAnswer("Next answer")
      await registry.submit(123, "next addressed question")
      const context = JSON.stringify(fixture.requests.at(-1)?.messages)
      expect(context).toContain("passive background only")
      expect(context.indexOf("passive background only")).toBeLessThan(
        context.lastIndexOf("next addressed question"),
      )
    } finally {
      release()
      await registry.dispose()
    }
  })
})
