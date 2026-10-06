import { describe, expect, it } from "vitest"
import { Progress, Routing } from "../src/agent/durable-prototype/runtime.js"
import { context, directory, fauxAssistantMessage, open } from "./durable-support.js"

describe("Pi Durable fork and application state", () => {
  it("evicts oldest replies by bytes independently of the record count", async () => {
    const { runtime } = await open(
      await directory(),
      [fauxAssistantMessage("1"), fauxAssistantMessage("2")],
      undefined,
      { records: 10, bytes: 100 },
    )
    const first = await (await runtime.submit("1", "1")).wait(context)
    const second = await (await runtime.submit("2", "2")).wait(context)
    await runtime.recordReply(first, [100, 101, 102, 103, 104, 105, 106, 107])
    await runtime.recordReply(second, [200, 201, 202, 203, 204, 205, 206, 207])
    expect((await runtime.harness.snapshot(Routing, context))?.replies).toHaveLength(1)
    expect(await runtime.forkReply(100)).toBe(false)
    expect(await runtime.forkReply(200)).toBe(true)
  })

  it("forks a delivered checkpoint across reopen and carries recent untrusted passive context", async () => {
    const dir = await directory()
    const first = await open(dir, [fauxAssistantMessage("root"), fauxAssistantMessage("later")])
    const answer = await (await first.runtime.submit("1", "root")).wait(context)
    await first.runtime.recordReply(answer, [100, 101])
    await (await first.runtime.submit("2", "later")).wait(context)
    await (await first.runtime.passive("group background")).wait(context)
    await first.runtime.close()
    const { runtime } = await open(dir)
    expect(await runtime.forkReply(101)).toBe(true)
    const view = await (await runtime.conversation()).context(context)
    expect(JSON.stringify(view.messages)).not.toContain("later")
    expect(JSON.stringify(view.messages)).toContain("group background")
    await (await runtime.submit("3", "current question")).wait(context)
    const messages = (await (await runtime.conversation()).context(context)).messages
    const source = JSON.stringify(messages)
    expect(source.indexOf("group background")).toBeLessThan(source.indexOf("current question"))
    expect(await runtime.forkReply(999)).toBe(false)
  })

  it("keeps the correct as-of progress after compaction, restart and a fork", async () => {
    const dir = await directory()
    const first = await open(dir, [fauxAssistantMessage("root"), fauxAssistantMessage("later")])
    const conversation = await first.runtime.conversation()
    await conversation.commit(async (tx) => {
      ;(await tx.doc(Progress, conversation.id)).steps = ["original"]
    }, context)
    const answer = await (await first.runtime.submit("1", "root")).wait(context)
    if (answer.status !== "done" || answer.type !== "input") throw new Error("Missing answer")
    await first.runtime.recordReply(answer, [100])
    await conversation.commit(async (tx) => {
      ;(await tx.doc(Progress, conversation.id)).steps = ["later"]
    }, context)
    await (await first.runtime.submit("2", "later")).wait(context)
    await (
      await conversation.submit(
        {
          type: "write",
          entry: {
            kind: "pi.compaction",
            data: { reason: "manual" },
            head: answer.answer,
            model: [{ role: "user", content: "summary", timestamp: Date.now() }],
          },
        },
        context,
      )
    ).wait(context)
    expect(JSON.stringify((await conversation.context(context)).messages)).toContain("summary")
    await first.runtime.close()
    const { runtime } = await open(dir)
    expect(await runtime.forkReply(100)).toBe(true)
    const fork = await runtime.conversation()
    expect((await runtime.harness.snapshot(Progress, fork.id, context))?.steps).toEqual([
      "original",
    ])
  })

  it("retains bounded aliases, replaces duplicates, isolates count eviction and rolls back oversize writes", async () => {
    const { runtime } = await open(
      await directory(),
      [fauxAssistantMessage("1"), fauxAssistantMessage("2"), fauxAssistantMessage("3")],
      undefined,
      { records: 2, bytes: 1024 },
    )
    const first = await (await runtime.submit("1", "1")).wait(context)
    const second = await (await runtime.submit("2", "2")).wait(context)
    const third = await (await runtime.submit("3", "3")).wait(context)
    await runtime.recordReply(first, [10, 11, -1, 10])
    await runtime.recordReply(second, [20])
    await runtime.recordReply(third, [30])
    expect(
      (await runtime.harness.snapshot(Routing, context))?.replies.map((reply) => reply.ids),
    ).toEqual([[20], [30]])
    await runtime.recordReply(second, [30])
    expect(
      (await runtime.harness.snapshot(Routing, context))?.replies.map((reply) => reply.ids),
    ).toEqual([[20], [30]])
    await expect(
      runtime.recordReply(
        first,
        Array.from({ length: 1000 }, (_, index) => index + 100),
      ),
    ).rejects.toThrow("Reply limit exceeded")
    expect(
      (await runtime.harness.snapshot(Routing, context))?.replies.map((reply) => reply.ids),
    ).toEqual([[20], [30]])
  })

  it("demonstrates that native request IDs do not deduplicate across a reply fork", async () => {
    const { runtime } = await open(await directory(), [
      fauxAssistantMessage("1"),
      fauxAssistantMessage("duplicate"),
    ])
    const first = await runtime.submit("telegram:1:1", "question")
    const answer = await first.wait(context)
    await runtime.recordReply(answer, [100])
    await runtime.forkReply(100)
    const duplicate = await runtime.submit("telegram:1:1", "question")
    expect(duplicate.id).not.toBe(first.id)
    expect((await duplicate.wait(context)).status).toBe("done")
  })
})
