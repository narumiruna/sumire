import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import { createModels } from "pi-durable-ai/models"
import {
  fauxProvider,
  fauxAssistantMessage,
  type FauxResponseStep,
} from "pi-durable-ai/providers/faux"
import { createRegistry, type Registry } from "@earendil-works/pi-durable"
import { afterEach } from "vitest"
import { DurablePrototype } from "../src/agent/durable-prototype/runtime.js"

export { context, fauxAssistantMessage }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

export async function directory() {
  const value = await mkdtemp(path.join(tmpdir(), "sumire-durable-"))
  cleanups.push(() => rm(value, { recursive: true, force: true }))
  return value
}

export async function open(
  dir: string,
  responses: FauxResponseStep[] = [fauxAssistantMessage("ok")],
  registry: Registry = createRegistry(),
  limits?: { records: number; bytes: number },
) {
  const faux = fauxProvider({ models: [{ id: "faux-1", input: ["text", "image"] }] })
  faux.setResponses(responses)
  const models = createModels()
  models.setProvider(faux.provider)
  const runtime = await DurablePrototype.open(dir, models, registry, limits)
  cleanups.push(() => runtime.close())
  return { runtime, faux }
}

export function hold() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  const gate = { promise, resolve }
  return {
    ...gate,
    response: async (_input: unknown, options: { signal?: AbortSignal } | undefined) => {
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted) return resolve()
        options?.signal?.addEventListener("abort", () => resolve(), { once: true })
        gate.promise.then(resolve)
      })
      return fauxAssistantMessage("released")
    },
  }
}
