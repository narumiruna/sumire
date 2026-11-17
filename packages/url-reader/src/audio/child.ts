import { createReadStream } from "node:fs"
import type { AutomaticSpeechRecognitionPipeline, Tensor } from "@huggingface/transformers"
import { loadWhisperPipeline } from "./model.js"
import {
  AudioMessageReader,
  type AudioPhase,
  type AudioRequest,
  AudioTranscriptionError,
  encodeAudioMessage,
  isRecord,
  resolveAudioModel,
  SAMPLE_RATE,
} from "./protocol.js"

let transcriber: AutomaticSpeechRecognitionPipeline | undefined
let loadedModel: string | undefined
let busy = false
let phase: AudioPhase = "model_load"
let continuePhase: (() => void) | undefined

// Disconnect must terminate native work, not merely cancel a JavaScript promise.
process.on("disconnect", () => process.exit(0))
if (!process.connected) process.exit(0)
process.stdin.on("end", () => process.exit(0))
process.stdin.on("error", () => process.exit(1))
process.stdout.on("error", () => process.exit(1))

function send(message: unknown): void {
  process.stdout.write(encodeAudioMessage(message))
}

/** Wait for the parent callback before starting model loading or inference. */
async function enterPhase(next: AudioPhase): Promise<void> {
  phase = next
  await new Promise<void>((resolvePhase) => {
    continuePhase = resolvePhase
    send({ type: "phase", phase: next })
  })
}

async function loadModel(model: string): Promise<AutomaticSpeechRecognitionPipeline> {
  if (transcriber && loadedModel === model) return transcriber
  await transcriber?.dispose()
  transcriber = undefined
  loadedModel = undefined
  try {
    import.meta.resolve("@huggingface/transformers")
  } catch (error) {
    if (isRecord(error) && error.code === "ERR_MODULE_NOT_FOUND") {
      throw new AudioTranscriptionError(
        "dependency_missing",
        "model_load",
        "@huggingface/transformers",
      )
    }
    throw error
  }
  transcriber = await loadWhisperPipeline(model)
  loadedModel = model
  return transcriber
}

async function readAudio(request: AudioRequest): Promise<Float32Array> {
  const audio = new Float32Array(request.samples)
  const bytes = Buffer.from(audio.buffer)
  let offset = 0
  for await (const chunk of createReadStream(request.path)) {
    const part = chunk as Buffer
    if (offset + part.length > bytes.length) {
      throw new AudioTranscriptionError("transcription_failed", "inference")
    }
    part.copy(bytes, offset)
    offset += part.length
  }
  if (offset !== bytes.length) {
    throw new AudioTranscriptionError("transcription_failed", "inference")
  }
  return audio
}

/** 4.3.2 otherwise defaults Whisper to English, even for multilingual models. */
async function detectLanguage(
  pipeline: AutomaticSpeechRecognitionPipeline,
  audio: Float32Array,
): Promise<string> {
  const { Tensor } = await import("@huggingface/transformers")
  const tensors = new Set<Tensor>()
  const visited = new Set<object>()
  const collect = (value: unknown): void => {
    if (value instanceof Tensor) {
      tensors.add(value)
    } else if (typeof value === "object" && value !== null && !visited.has(value)) {
      visited.add(value)
      for (const item of Object.values(value)) collect(item)
    }
  }
  try {
    const features: Record<string, unknown> = await pipeline.processor(
      audio.subarray(0, 30 * SAMPLE_RATE),
    )
    collect(features)
    const config: unknown = pipeline.model.generation_config
    if (
      !isRecord(config) ||
      !Number.isSafeInteger(config.decoder_start_token_id) ||
      !isRecord(config.lang_to_id)
    ) {
      throw new AudioTranscriptionError("transcription_failed", "inference")
    }
    const decoder = new Tensor("int64", [BigInt(config.decoder_start_token_id as number)], [1, 1])
    tensors.add(decoder)
    const output: Record<string, unknown> = await pipeline.model({
      ...features,
      decoder_input_ids: decoder,
    })
    collect(output)
    if (!(output.logits instanceof Tensor)) {
      throw new AudioTranscriptionError("transcription_failed", "inference")
    }
    let best: string | undefined
    let bestScore = -Infinity
    for (const [token, id] of Object.entries(config.lang_to_id)) {
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) continue
      const score = Number(output.logits.data[id])
      if (score > bestScore) {
        best = token
        bestScore = score
      }
    }
    if (!best || !/^<\|[a-z]{2,3}\|>$/u.test(best)) {
      throw new AudioTranscriptionError("transcription_failed", "inference")
    }
    return best.slice(2, -2)
  } finally {
    for (const tensor of tensors) tensor.dispose()
  }
}

async function transcribe(request: AudioRequest): Promise<void> {
  try {
    await enterPhase("model_load")
    const pipeline = await loadModel(request.model)
    await enterPhase("inference")
    const audio = await readAudio(request)
    const language = await detectLanguage(pipeline, audio)
    const result = await pipeline(audio, {
      language,
      task: "transcribe",
      chunk_length_s: 30,
      stride_length_s: 5,
    })
    const text = result.text.trim()
    if (!text) throw new AudioTranscriptionError("empty_content", "inference")
    send({ type: "result", text })
  } catch (error) {
    const safe =
      error instanceof AudioTranscriptionError
        ? error
        : new AudioTranscriptionError("transcription_failed", phase)
    send({ type: "error", kind: safe.kind, phase: safe.phase, dependency: safe.dependency })
  } finally {
    busy = false
  }
}

const reader = new AudioMessageReader()
process.stdin.on("data", (chunk: Buffer) => {
  try {
    reader.push(chunk, (message) => {
      if (!isRecord(message)) throw new Error("Invalid audio control message")
      if (message.type === "continue" && message.phase === phase && continuePhase) {
        const resume = continuePhase
        continuePhase = undefined
        resume()
      } else if (message.type === "dispose" && !busy) {
        busy = true
        void Promise.resolve(transcriber?.dispose()).finally(() => process.exit(0))
      } else if (
        message.type === "transcribe" &&
        !busy &&
        typeof message.path === "string" &&
        typeof message.model === "string" &&
        typeof message.samples === "number" &&
        Number.isSafeInteger(message.samples) &&
        message.samples > 0
      ) {
        busy = true
        void transcribe({
          type: "transcribe",
          path: message.path,
          model: resolveAudioModel(message.model),
          samples: message.samples,
        })
      } else {
        throw new Error("Invalid audio control message")
      }
    })
  } catch {
    process.exit(1)
  }
})
