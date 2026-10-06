import { appendFile } from "node:fs/promises"
import path from "node:path"
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import { Type } from "pi-durable-ai"
import { createModels } from "pi-durable-ai/models"
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "pi-durable-ai/providers/faux"
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable"
import { DurablePrototype } from "../../src/agent/durable-prototype/runtime.js"

const [dir, mode] = process.argv.slice(2)
if (!dir || !mode) throw new Error("Missing fixture args")
const registry = createRegistry()
const faux = fauxProvider()
const models = createModels()
models.setProvider(faux.provider)
let admit = (_id: number) => {}
const admitted = new Promise<number>((resolve) => {
  admit = resolve
})
if (mode.startsWith("tool")) {
  registry.install(
    defineExtension({
      name: "test-tool",
      tools: [
        defineTool({
          name: "probe",
          parameters: Type.Object({}),
          description: "Read-only test probe",
          replay: mode === "tool-safe" ? "safe" : "unsafe",
          execute: async () => {
            await appendFile(path.join(dir, "calls.txt"), "call\n")
            process.send?.({ phase: "ready", ids: [await admitted] })
            await new Promise(() => {})
            return {}
          },
        }),
      ],
    }),
  )
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("probe", {}, { id: "probe-1" }), { stopReason: "toolUse" }),
  ])
} else {
  faux.setResponses([
    async () => {
      if (mode === "generation") process.send?.({ phase: "ready", ids: [await admitted] })
      await new Promise(() => {})
      return fauxAssistantMessage("never")
    },
  ])
}
const runtime = await DurablePrototype.open(dir, models, registry)
const first = await runtime.submit("first", "first")
admit(first.id)
if (mode === "queued") {
  const second = await runtime.submit("second", "second")
  const steer = await runtime.submit("steer", "steer", "steer")
  const note = await runtime.passive("background")
  process.send?.({ phase: "ready", ids: [first.id, second.id, steer.id, note.id] })
} else if (mode === "admission") {
  process.send?.({ phase: "ready", ids: [first.id] })
}
// Keep the fixture alive until the parent kills it; there are no real providers or external APIs.
setInterval(() => {}, 1000)
await first.wait(context)
