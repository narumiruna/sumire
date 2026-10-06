import { withAbortSignal } from "@earendil-works/chord/context"
import { describe, expect, it, vi } from "vitest"
import { context, directory, fauxAssistantMessage, hold, open } from "./durable-support.js"

describe("isolated Pi Durable runtime", () => {
  it("resumes work after a graceful close without converting it to a permanent abort", async () => {
    const dir = await directory()
    const gate = hold()
    const first = await open(dir, [gate.response])
    const submission = await first.runtime.submit("1", "first")
    await vi.waitFor(() => expect(first.faux.state.callCount).toBe(1))
    await first.runtime.close()
    const next = await open(dir, [fauxAssistantMessage("resumed")])
    const reopened = await next.runtime.harness.submission(submission.id, context)
    if (!reopened) throw new Error("Missing admitted work")
    expect(await next.runtime.answer(await reopened.wait(context))).toBe("resumed")
    gate.resolve()
  })

  it("forwards synthetic image input and image tool results without conflating them with built-in read", async () => {
    const { createRegistry, defineExtension, defineTool } = await import(
      "@earendil-works/pi-durable"
    )
    const { Type } = await import("pi-durable-ai")
    const { fauxToolCall } = await import("pi-durable-ai/providers/faux")
    const image = {
      type: "image" as const,
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH2cAAAAASUVORK5CYII=",
    }
    const registry = createRegistry()
    registry.install(
      defineExtension({
        name: "image",
        tools: [
          defineTool({
            name: "image_probe",
            description: "Return a synthetic image",
            parameters: Type.Object({}),
            replay: "safe",
            execute: async () => ({ content: [image] }),
          }),
        ],
      }),
    )
    let sawInput = false
    let sawResult = false
    const { runtime } = await open(
      await directory(),
      [
        async (request) => {
          sawInput = JSON.stringify(request.messages).includes(image.data)
          return fauxAssistantMessage(fauxToolCall("image_probe", {}, { id: "image-1" }), {
            stopReason: "toolUse",
          })
        },
        async (request) => {
          sawResult = request.messages.some(
            (message) =>
              message.role === "toolResult" && JSON.stringify(message.content).includes(image.data),
          )
          return fauxAssistantMessage("image received")
        },
      ],
      registry,
    )
    await (await runtime.submit("image", [{ type: "text", text: "inspect" }, image])).wait(context)
    expect(sawInput).toBe(true)
    expect(sawResult).toBe(true)
  })

  it("persists answers and deduplicates requests in the same conversation across reopen", async () => {
    const dir = await directory()
    const first = await open(dir)
    const submission = await first.runtime.submit("telegram:1:1", "hello")
    expect(await first.runtime.answer(await submission.wait(context))).toBe("ok")
    await first.runtime.close()
    const next = await open(dir)
    const again = await next.runtime.submit("telegram:1:1", "hello")
    expect(again.id).toBe(submission.id)
    expect(await next.runtime.answer(await again.wait(context))).toBe("ok")
    expect(next.faux.state.callCount).toBe(0)
  })

  it("isolates chat storage and physically resets one chat without deleting shared auth", async () => {
    const root = await directory()
    const { writeFile, readFile } = await import("node:fs/promises")
    const path = await import("node:path")
    const auth = path.join(root, "auth.json")
    await writeFile(auth, "{}")
    const first = await open(path.join(root, "1"))
    const second = await open(path.join(root, "2"))
    await (await first.runtime.submit("same", "first")).wait(context)
    await (await second.runtime.submit("same", "second")).wait(context)
    await first.runtime.reset()
    const replacement = await open(path.join(root, "1"), [fauxAssistantMessage("new")])
    expect(
      await replacement.runtime.answer(
        await (await replacement.runtime.submit("same", "new")).wait(context),
      ),
    ).toBe("new")
    expect(second.faux.state.callCount).toBe(1)
    expect(await readFile(auth, "utf8")).toBe("{}")
    expect((await replacement.runtime.harness.inspect(context)).tasks).toHaveLength(0)
  })

  it("queues steering, follow-up and passive context without changing the active model request", async () => {
    const gate = hold()
    const { runtime, faux } = await open(await directory(), [
      gate.response,
      fauxAssistantMessage("next"),
    ])
    const first = await runtime.submit("1", "first")
    await vi.waitFor(() => expect(faux.state.callCount).toBe(1))
    const steer = await runtime.submit("2", "steer", "steer")
    const follow = await runtime.submit("3", "follow")
    const note = await runtime.passive("background")
    const before = await (await runtime.conversation()).context(context)
    expect(JSON.stringify(before.messages)).not.toContain("background")
    gate.resolve()
    await first.wait(context)
    await steer.wait(context)
    await follow.wait(context)
    await note.wait(context)
    const entries = await (await runtime.conversation()).entries({}, 50, undefined, context)
    expect(entries.items.filter((entry) => entry.kind === "sumire.passive")).toHaveLength(1)
  })

  it("cancels a waiter without cancelling work, then explicitly aborts active and queued input", async () => {
    const gate = hold()
    const { runtime, faux } = await open(await directory(), [gate.response])
    const first = await runtime.submit("1", "first")
    await vi.waitFor(() => expect(faux.state.callCount).toBe(1))
    const queued = await runtime.submit("2", "queued")
    const controller = new AbortController()
    const waiting = first.wait(withAbortSignal(controller.signal, context))
    controller.abort()
    await expect(waiting).rejects.toThrow()
    expect((await first.status(context)).status).not.toBe("unanswered")
    await runtime.cancel()
    expect((await first.wait(context)).status).toBe("unanswered")
    expect((await queued.wait(context)).status).toBe("unanswered")
    gate.resolve()
    await runtime.cancel()
    expect((await runtime.harness.inspect(context)).tasks).toHaveLength(0)
  })
})
