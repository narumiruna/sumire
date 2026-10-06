import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import { CompactionEntry, type ConversationId, type EntryId } from "@earendil-works/pi-durable"
import { afterEach, describe, expect, it } from "vitest"

import { BotSessionDoc } from "../src/agent/durable-state.js"
import { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { createPiFixture, toolResultText } from "./helpers/pi-fixture.js"

const fixtures: Awaited<ReturnType<typeof createPiFixture>>[] = []
const setup = async () => {
  const fixture = await createPiFixture()
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
})

describe("durable reply-tree behavior", () => {
  it("forks sibling conversations and restores an abandoned sibling after storage reopen", async () => {
    const fixture = await setup()
    const session = await fixture.createSession()
    const registry = new ChatSessionRegistry(
      async () => session,
      fixture.settings.botSessionLogDir,
      fixture.logger,
      { replyTreeEnabled: true },
    )
    const ask = async (question: string, replyToBotMessageId?: number) => {
      fixture.enqueueAnswer(`${question} answer`)
      const answer = await registry.submit(123, question, { replyToBotMessageId })
      if (answer.kind !== "completed") throw new Error("Missing answer")
      return answer
    }
    const first = await ask("root")
    await registry.recordDelivery(123, first.checkpoint, [100])
    await ask("abandoned latest")
    const branchA = await ask("branch A", 100)
    await registry.recordDelivery(123, branchA.checkpoint, [101])
    await ask("branch B", 100)
    expect(JSON.stringify(session.messages)).toContain("branch B answer")
    expect(JSON.stringify(session.messages)).not.toContain("branch A")
    expect(JSON.stringify(session.messages)).not.toContain("abandoned latest")
    await registry.dispose()
    const reopened = await fixture.createSession()
    expect(JSON.stringify(reopened.messages)).toContain("branch B answer")
    const second = new ChatSessionRegistry(
      async () => reopened,
      fixture.settings.botSessionLogDir,
      fixture.logger,
      { replyTreeEnabled: true },
    )
    try {
      fixture.enqueueAnswer("restored A")
      await second.submit(123, "reply after restart", { replyToBotMessageId: 101 })
      expect(JSON.stringify(reopened.messages)).toContain("branch A answer")
      expect(JSON.stringify(reopened.messages)).not.toContain("branch B")
      expect(reopened.sessionId).toBe(session.sessionId)
    } finally {
      await second.dispose()
    }
  })

  it("keeps progress and codemode state when compaction removes their old result entries", async () => {
    const fixture = await setup()
    const session = await fixture.createSession()
    await fixture.call(session, "update_progress", {
      steps: [{ text: "persistent progress", status: "pending" }],
    })
    await fixture.script(session, "store('marker', 'persistent store')")
    const leaf = session.sessionManager.getLeafId()
    if (!leaf) throw new Error("Missing checkpoint")
    const saved = await session.harness.snapshot(BotSessionDoc, context)
    const conversation = await session.harness.conversation(
      saved?.activeConversation as ConversationId,
      context,
    )
    if (!conversation) throw new Error("Missing conversation")
    // Exercise the durable context boundary without paying for a real summarization request.
    await conversation.commit(
      (tx) =>
        tx.appendEntry(CompactionEntry, conversation.id, {
          head: Number(leaf.split(":")[1]) as EntryId,
          data: { reason: "manual" },
          model: [{ role: "user", content: "Earlier work summarized", timestamp: Date.now() }],
        }),
      context,
    )
    await session.dispose()
    const reopened = await fixture.createSession()
    expect(
      reopened.messages.some(
        (message) => message.role === "toolResult" && message.toolName === "update_progress",
      ),
    ).toBe(false)
    const result = await fixture.script(reopened, "return load('marker')")
    expect(toolResultText(result)).toContain("persistent store")
    expect(JSON.stringify(fixture.requests.at(-2)?.messages)).toContain("persistent progress")
  })
})
