import { Type } from "@earendil-works/pi-ai"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { defineTool, LiveDoc } from "@earendil-works/pi-durable"
import type { ToolAvailability } from "@narumitw/sumire-contracts"
import { generateImage, ImagegenError, isCanonicalCodexRoot } from "@narumitw/sumire-imagegen"
import type { GeneratedMediaFiles } from "./durable/media.js"
import { OutboxDoc } from "./durable/state.js"

export const IMAGEGEN_TOOL = "generate_image"
const provider = "openai-codex"

/** Public metadata only: never resolve credentials or probe the image endpoint. */
export async function getImagegenAvailability(
  runtime: ModelRuntime,
  signal?: AbortSignal,
): Promise<ToolAvailability> {
  const compatible = () => {
    const configured = runtime.getProvider(provider)
    const models = runtime.getModels(provider)
    return (
      !!configured?.auth.oauth &&
      isCanonicalCodexRoot(configured.baseUrl) &&
      models.length > 0 &&
      models.every((model) => isCanonicalCodexRoot(model.baseUrl))
    )
  }
  const incompatible = {
    available: false,
    reason: "Requires the canonical openai-codex provider with OAuth support.",
  }
  signal?.throwIfAborted()
  if (!compatible()) return incompatible
  let credentials: Awaited<ReturnType<ModelRuntime["listCredentials"]>>
  try {
    credentials = await runtime.listCredentials({ signal })
  } catch {
    signal?.throwIfAborted()
    return { available: false, reason: "Codex credential metadata is unavailable." }
  }
  signal?.throwIfAborted()
  if (!compatible()) return incompatible
  const available = credentials.some(
    (entry) => entry.providerId === provider && entry.type === "oauth",
  )
  return {
    available,
    reason: available
      ? "Codex OAuth is configured; experimental image access is not verified."
      : "Requires compatible openai-codex OAuth. Check Model providers.",
  }
}

export async function hasCodexImageAuth(
  runtime: ModelRuntime,
  signal?: AbortSignal,
): Promise<boolean> {
  return (await getImagegenAvailability(runtime, signal)).available
}

export function createImagegenTool(
  runtime: ModelRuntime,
  files: GeneratedMediaFiles,
  authorize: () => void,
) {
  const check = async (signal?: AbortSignal) => {
    authorize()
    if (!(await hasCodexImageAuth(runtime, signal))) throw new ImagegenError("auth")
    authorize()
    signal?.throwIfAborted()
  }
  return defineTool({
    name: IMAGEGEN_TOOL,
    description:
      "Generate one new image from a text prompt and queue it for delivery to the current Telegram chat. This experimental Codex operation consumes account quota. Returns an artifact receipt, not a URL or local path. Do not retry failed, interrupted, or timed-out generation automatically; remote generation may continue. Image editing and reference images are not supported.",
    parameters: Type.Object(
      { prompt: Type.String({ minLength: 1, maxLength: 32_000 }) },
      { additionalProperties: false },
    ),
    structuredOutputSchema: Type.Object({
      id: Type.String(),
      mimeType: Type.String(),
      width: Type.Number(),
      height: Type.Number(),
      byteLength: Type.Number(),
    }),
    replay: "unsafe",
    async execute(args, api, context) {
      await check(context.abortSignal)
      context.abortSignal?.throwIfAborted()
      // The native run binds direct and nested calls to input submissions, not text or a mutable host slot.
      const requestId = await api.commit(async (tx) => {
        const live = await tx.doc(LiveDoc, api.conversationId)
        for (const item of (await tx.doc(OutboxDoc)).pending) {
          if (item.conversationId !== api.conversationId) continue
          for (const id of [item.requestId, ...(item.relatedRequestIds ?? [])]) {
            const input = await tx.submissionByRequest(api.conversationId, id)
            if (input && live.run?.inputs.includes(input.id)) return item.requestId
          }
        }
        throw new Error("Image generation requires a pending Telegram response")
      }, context)
      await check(context.abortSignal)
      try {
        await files.prepare()
      } catch {
        throw new Error("Image storage is unavailable. No generation request was made.")
      }
      await check(context.abortSignal)
      context.abortSignal?.throwIfAborted()
      const image = await generateImage(args, {
        signal: context.abortSignal,
        async resolveAuth(signal) {
          await check(signal)
          if ((await runtime.checkAuth(provider, { signal }))?.type !== "oauth")
            throw new ImagegenError("auth")
          await check(signal)
          const resolved = await runtime.getAuth(provider, { signal })
          await check(signal)
          signal.throwIfAborted()
          if (
            !resolved?.auth.apiKey ||
            (resolved.auth.baseUrl !== undefined && !isCanonicalCodexRoot(resolved.auth.baseUrl))
          )
            throw new ImagegenError("auth")
          return { accessToken: resolved.auth.apiKey }
        },
      })
      await check(context.abortSignal)
      context.abortSignal?.throwIfAborted()
      let saved: Awaited<ReturnType<GeneratedMediaFiles["save"]>> | undefined
      let committed = false
      try {
        saved = await files.save(image, context.abortSignal)
        await check(context.abortSignal)
        context.abortSignal?.throwIfAborted()
        const receipt = { ...saved, taskId: api.taskId as number, callId: api.callId }
        await api.commit(async (tx) => {
          await check(context.abortSignal)
          const pending = (await tx.doc(OutboxDoc)).pending.find(
            (item) => item.requestId === requestId && item.conversationId === api.conversationId,
          )
          if (!pending) throw new Error("Image delivery was cancelled")
          pending.media = [...(pending.media ?? []), receipt]
        }, context)
        committed = true
        const data = {
          id: saved.id,
          mimeType: saved.mimeType,
          width: saved.width,
          height: saved.height,
          byteLength: saved.byteLength,
        }
        return {
          output: [
            { type: "text" as const, text: "Image generated and queued for Telegram delivery." },
          ],
          structuredOutput: data,
          details: data,
        }
      } catch {
        throw new Error(
          "Generated image could not be saved for delivery. Do not generate again automatically.",
        )
      } finally {
        if (saved && !committed) {
          try {
            await files.remove(saved)
          } catch {
            /* Startup pruning removes orphaned files. */
          }
        }
      }
    },
  })
}
