import type { Bot } from "grammy"
import { expect, it, vi } from "vitest"
import type { DurableAnswer } from "../src/agent/durable/outbox.js"
import type { DurableSession } from "../src/agent/durable/session.js"
import { ChatSessionRegistry } from "../src/agent/session-registry.js"
import { ScheduleStore } from "../src/schedules/store.js"
import type { createTelegramDelivery } from "../src/telegram/delivery.js"
import { runScheduledTask } from "../src/telegram/scheduled-task.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

it("executes a persisted scheduled message through real Pi Durable and recovers its unsent answer without another model turn", async () => {
  const fixture = await createPiFixture()
  const control = fixture.factory.control
  control.observe(42, "private", "Fixture chat")
  const schedules = new ScheduleStore(control)
  const now = Date.now()
  schedules.create(
    {
      chatId: 42,
      task: "Literal scheduled fixture task",
      runAt: now + 1000,
      timeZone: "Asia/Taipei",
      repeatMinutes: null,
    },
    "7",
    now,
  )
  const run = schedules.claim(now + 1000)
  if (!run) throw new Error("Missing scheduled fixture occurrence")
  let session: DurableSession | undefined
  const registry = new ChatSessionRegistry(
    async (id) => {
      session = await fixture.createSession(id)
      return session
    },
    fixture.settings.botSessionLogDir,
    fixture.logger,
    { control },
  )
  const bot = {
    botInfo: { id: 99, is_bot: true, first_name: "Fixture", username: "fixture_bot" },
    api: {
      sendMessage: vi.fn(async () => ({
        message_id: 200,
        date: 0,
        chat: { id: 42, type: "private", first_name: "Fixture" },
        text: "Pending",
      })),
    },
  } as unknown as Bot
  const delivery = {
    editOrReply: vi.fn(async () => {
      throw new Error("synthetic delivery failure")
    }),
  } as unknown as ReturnType<typeof createTelegramDelivery>
  fixture.enqueueAnswer("Persisted scheduled answer")
  try {
    await expect(
      runScheduledTask(
        run.schedule,
        bot,
        registry,
        delivery,
        () => control.allows(42),
        fixture.logger,
      ),
    ).rejects.toThrow("synthetic delivery failure")
    schedules.finish(run, false)
    expect(fixture.requests).toHaveLength(1)
    expect(JSON.stringify(fixture.requests[0]?.messages)).toContain(
      "Literal scheduled fixture task",
    )
    expect(await session?.hasPendingResponses()).toBe(true)
    await registry.dispose()
    schedules.recoverInterrupted()
    expect(schedules.claim(Date.now() + 86400_000)).toBeUndefined()
    let acknowledged = false
    const restarted = new ChatSessionRegistry(
      async (id) => {
        const recovered = await fixture.createSession(id)
        const acknowledge = recovered.acknowledge.bind(recovered)
        vi.spyOn(recovered, "acknowledge").mockImplementation(async (requestId) => {
          await acknowledge(requestId)
          acknowledged = true
        })
        return recovered
      },
      fixture.settings.botSessionLogDir,
      fixture.logger,
      { control },
    )
    const deliver = vi.fn(async (_id: number, answer: DurableAnswer) => {
      expect(answer.text).toBe("Persisted scheduled answer")
      return true
    })
    try {
      await restarted.recover([42], deliver)
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(acknowledged).toBe(true))
      await restarted.dispose()
      const inspected = await fixture.createSession(42)
      expect(await inspected.hasPendingResponses()).toBe(false)
      await inspected.dispose()
      expect(fixture.requests).toHaveLength(1)
      expect(schedules.list().items[0]).toMatchObject({ state: "paused", lastOutcome: "failed" })
    } finally {
      await restarted.dispose()
    }
  } finally {
    await registry.dispose()
    await fixture.cleanup()
  }
}, 15_000)
