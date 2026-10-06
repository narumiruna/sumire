import { describe, expect, it, vi } from "vitest"
import { deliver, Deliveries, queueDelivery } from "../src/agent/durable-prototype/delivery.js"
import { context, directory, open } from "./durable-support.js"

describe("durable delivery ledger experiment", () => {
  it("demonstrates that admission without a host ledger cannot reconstruct Telegram delivery metadata", async () => {
    const dir = await directory()
    const first = await open(dir)
    const submission = await first.runtime.submit("telegram:1:42", "question")
    await submission.wait(context)
    await first.runtime.close()
    const { runtime } = await open(dir)
    const existing = await runtime.harness.submission(submission.id, context)
    if (!existing) throw new Error("Missing durable submission")
    expect((await existing.status(context)).status).toBe("done")
    expect(await runtime.harness.snapshot(Deliveries, context)).toBeUndefined()
  })

  it("refuses delivery for cancelled work even when a late callback attempts to queue it", async () => {
    const { hold } = await import("./durable-support.js")
    const gate = hold()
    const { runtime } = await open(await directory(), [gate.response])
    const submission = await runtime.submit("1", "question")
    await runtime.cancel()
    const settled = await submission.wait(context)
    await expect(queueDelivery(runtime.harness, settled, 100)).rejects.toThrow(
      "Cannot deliver unanswered input",
    )
    expect(await runtime.harness.snapshot(Deliveries, context)).toBeUndefined()
    gate.resolve()
  })

  it("resumes answered-but-undelivered work and persists source, status, checkpoint and receipt", async () => {
    const dir = await directory()
    const first = await open(dir)
    const settled = await (await first.runtime.submit("1", "question")).wait(context)
    await queueDelivery(first.runtime.harness, settled, 100, 101)
    await first.runtime.close()
    const { runtime } = await open(dir)
    const send = vi.fn(async () => 102)
    expect(await deliver(runtime.harness, settled.id, send)).toBe(true)
    expect(await deliver(runtime.harness, settled.id, send)).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
    expect((await runtime.harness.snapshot(Deliveries, context))?.records[0]).toMatchObject({
      sourceMessageId: 100,
      statusMessageId: 101,
      outcome: "delivered",
      messageId: 102,
    })
  })

  it.each(["telegram", "morsel"])(
    "does not blindly replay uncertain %s success after a crash before its receipt",
    async () => {
      const dir = await directory()
      const first = await open(dir)
      const settled = await (await first.runtime.submit("1", "question")).wait(context)
      await queueDelivery(first.runtime.harness, settled, 100)
      const send = vi.fn(async () => 101)
      await expect(
        deliver(first.runtime.harness, settled.id, send, async () => {
          throw new Error("crash before receipt")
        }),
      ).rejects.toThrow("crash before receipt")
      await first.runtime.close()
      const { runtime } = await open(dir)
      expect(await deliver(runtime.harness, settled.id, send)).toBe(false)
      expect(send).toHaveBeenCalledTimes(1)
      expect((await runtime.harness.snapshot(Deliveries, context))?.records[0]?.outcome).toBe(
        "uncertain",
      )
    },
  )

  it("serializes concurrent claims and conservatively retains an uncertain transport failure", async () => {
    const { runtime } = await open(await directory())
    const settled = await (await runtime.submit("1", "question")).wait(context)
    await queueDelivery(runtime.harness, settled, 100)
    const send = vi.fn(async () => {
      throw new Error("transport unavailable")
    })
    const outcomes = await Promise.allSettled([
      deliver(runtime.harness, settled.id, send),
      deliver(runtime.harness, settled.id, send),
    ])
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect((await runtime.harness.snapshot(Deliveries, context))?.records[0]?.outcome).toBe(
      "uncertain",
    )
  })
})
