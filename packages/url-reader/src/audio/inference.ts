import type { AutomaticSpeechRecognitionPipeline, Tensor } from "@huggingface/transformers"
import { AudioTranscriptionError, isRecord, SAMPLE_RATE } from "./protocol.js"

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

export async function transcribeSamples(
  pipeline: AutomaticSpeechRecognitionPipeline,
  audio: Float32Array,
): Promise<string> {
  const config: unknown = pipeline.model.generation_config
  const englishOnly = isRecord(config) && config.is_multilingual === false
  const languageOptions = englishOnly
    ? {}
    : { language: await detectLanguage(pipeline, audio), task: "transcribe" }
  const result = await pipeline(audio, {
    ...languageOptions,
    chunk_length_s: 30,
    stride_length_s: 5,
  })
  const text = result.text.trim()
  if (!text) throw new AudioTranscriptionError("empty_content", "inference")
  return text
}
