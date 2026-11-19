import type { Schedule } from "@narumitw/sumire-contracts"
import type { Bot } from "grammy"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  ChatSessionRegistry,
  SubmissionOptions,
  SubmissionResult,
} from "../src/agent/session-registry.js"
import type { Logger } from "../src/logging.js"
import type { createTelegramDelivery } from "../src/telegram/delivery.js"
import { deliverGeneratedResponse } from "../src/telegram/media-delivery.js"
import { runScheduledTask } from "../src/telegram/scheduled-task.js"

vi.mock("../src/telegram/media-delivery.js", () => ({
  deliverGeneratedResponse: vi.fn(async () => "delivered"),
}))
const task: Schedule = {
  id: "45bc065b-0593-4804-bfa5-39a1c2cfb77f",
  revision: 2,
  chatId: 42,
  task: "/f this is literal scheduled user input",
  runAt: 1805673600000,
  timeZone: "Asia/Taipei",
  repeatMinutes: null,
  state: "active",
  createdAt: 1805670000000,
  nextRunAt: 1805673600000,
  lastRunAt: 1805673600100,
  lastOutcome: "running",
}
const checkpoint = {
  sessionId: "fixture-session",
  entryId: "entry:2",
  generation: 0,
  requestId: "fixture-request",
}
const logger = { warn: vi.fn(), info: vi.fn() } as unknown as Logger
function fixture(type: "private" | "channel" = "private") {
  const status = {
    message_id: 200,
    date: 0,
    chat: { id: 42, type, first_name: "Fixture", title: "Fixture" },
    text: "Pending",
  }
  const sendMessage = vi.fn(async () => status)
  const bot = {
    api: { sendMessage },
    botInfo: { id: 99, is_bot: true, first_name: "Fixture", username: "fixture_bot" },
  } as unknown as Bot
  const submit = vi.fn(
    async (
      _chatId: number,
      _prompt: string,
      _options?: SubmissionOptions,
    ): Promise<SubmissionResult> => ({
      kind: "completed",
      text: "Fixture answer",
      checkpoint,
      settlement: { status: "done" },
    }),
  )
  const recordDelivery = vi.fn(async () => {})
  const sessions = { submit, recordDelivery } as unknown as ChatSessionRegistry
  const editOrReply = vi.fn(async () => ({ result: "delivered", message: undefined }))
  const delivery = { editOrReply } as unknown as ReturnType<typeof createTelegramDelivery>
  return { bot, sessions, delivery, submit, sendMessage, recordDelivery, editOrReply }
}
beforeEach(() => vi.mocked(deliverGeneratedResponse).mockReset().mockResolvedValue("delivered"))
describe("scheduled messages use the existing durable Telegram flow", () => {
  it.each(["private", "channel"] as const)(
    "uses a real bot message as the recovery anchor for %s",
    async (type) => {
      const f = fixture(type)
      await runScheduledTask(task, f.bot, f.sessions, f.delivery, () => true, logger)
      expect(f.sendMessage).toHaveBeenCalledTimes(1)
      expect(f.submit).toHaveBeenCalledWith(
        42,
        expect.stringContaining(task.task),
        expect.objectContaining({
          routing: "main",
          intent: "newTurn",
          delivery: { sourceMessageId: 200, statusMessageId: 200, mode: "default" },
        }),
      )
      expect(f.submit.mock.calls[0]?.[1]).toContain("No Telegram sender identity is asserted")
      expect(f.submit.mock.calls[0]?.[1]).not.toContain(
        "Telegram sender role (verified by bot): admin",
      )
      // editOrReply returns no Message when an in-place edit succeeds.
      expect(f.recordDelivery).toHaveBeenCalledWith(42, checkpoint, [200])
    },
  )
  it("acknowledges the replacement message after an edit fallback", async () => {
    const f = fixture()
    f.editOrReply.mockResolvedValueOnce({
      result: "delivered",
      message: { message_id: 201 },
    } as never)
    await runScheduledTask(task, f.bot, f.sessions, f.delivery, () => true, logger)
    expect(f.recordDelivery).toHaveBeenCalledWith(42, checkpoint, [201])
  })
  it("does not send or admit a revoked task", async () => {
    const f = fixture()
    await expect(
      runScheduledTask(task, f.bot, f.sessions, f.delivery, () => false, logger),
    ).rejects.toThrow("no longer")
    expect(f.sendMessage).not.toHaveBeenCalled()
    expect(f.submit).not.toHaveBeenCalled()
  })
  it("rechecks access after the anchor send and leaves no model request when revoked", async () => {
    const f = fixture()
    const isCurrent = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    await expect(
      runScheduledTask(task, f.bot, f.sessions, f.delivery, isCurrent, logger),
    ).rejects.toThrow("no longer")
    expect(f.submit).not.toHaveBeenCalled()
  })
  it("leaves unconfirmed text delivery unacknowledged for the existing outbox recovery", async () => {
    const f = fixture()
    f.editOrReply.mockResolvedValueOnce({ result: "unavailable", message: undefined })
    await expect(
      runScheduledTask(task, f.bot, f.sessions, f.delivery, () => true, logger),
    ).rejects.toThrow("incomplete")
    expect(f.recordDelivery).not.toHaveBeenCalled()
    expect(f.submit).toHaveBeenCalledTimes(1)
  })
  it("uses the shared media receipt path without a second model submission", async () => {
    const f = fixture()
    f.submit.mockResolvedValueOnce({
      kind: "completed",
      text: "Fixture image",
      checkpoint,
      media: [{ id: "fixture-image" } as never],
    })
    await runScheduledTask(task, f.bot, f.sessions, f.delivery, () => true, logger)
    expect(deliverGeneratedResponse).toHaveBeenCalledTimes(1)
    expect(f.editOrReply).not.toHaveBeenCalled()
    expect(f.submit).toHaveBeenCalledTimes(1)
  })
  it("does not report an unanswered model turn as successful delivery", async () => {
    const f = fixture()
    f.submit.mockResolvedValueOnce({
      kind: "no_response",
      text: "No response",
      checkpoint,
      settlement: { status: "unanswered", reason: "aborted" },
    })
    await expect(
      runScheduledTask(task, f.bot, f.sessions, f.delivery, () => true, logger),
    ).rejects.toThrow("did not complete")
    expect(f.recordDelivery).toHaveBeenCalledTimes(1)
  })
})
