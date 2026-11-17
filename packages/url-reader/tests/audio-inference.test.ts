import { type AutomaticSpeechRecognitionPipeline, Tensor } from "@huggingface/transformers"
import { describe, expect, it, vi } from "vitest"
import { transcribeSamples } from "../src/audio/inference.js"

it("transcribes English-only models without language detection or multilingual options", async () => {
  const run = vi.fn(async () => ({ text: " English transcript " }))
  const model = Object.assign(vi.fn(), { generation_config: { is_multilingual: false } })
  const processor = vi.fn(async () => ({}))
  const pipeline = Object.assign(run, {
    model,
    processor,
  }) as unknown as AutomaticSpeechRecognitionPipeline
  const audio = new Float32Array(16_000)
  await expect(transcribeSamples(pipeline, audio)).resolves.toBe("English transcript")
  expect(processor).not.toHaveBeenCalled()
  expect(model).not.toHaveBeenCalled()
  expect(run).toHaveBeenCalledWith(audio, { chunk_length_s: 30, stride_length_s: 5 })
})

describe("multilingual inference", () => {
  it("keeps model-logit detection, transcription options, and temporary tensor cleanup", async () => {
    const features = new Tensor("float32", [0], [1])
    const logits = new Tensor("float32", [0, 0, -1, 5], [1, 1, 4])
    const cached = new Tensor("float32", [0], [1])
    const dispose = [features, logits, cached].map((tensor) => vi.spyOn(tensor, "dispose"))
    const run = vi.fn(async () => ({ text: "日文測試" }))
    const model = Object.assign(
      vi.fn(async () => ({ logits, past_key_values: { cached, repeated: [cached] } })),
      {
        generation_config: {
          is_multilingual: true,
          decoder_start_token_id: 1,
          lang_to_id: { "<|en|>": 2, "<|ja|>": 3 },
        },
      },
    )
    const processor = vi.fn(async () => ({ input_features: features }))
    const pipeline = Object.assign(run, {
      model,
      processor,
    }) as unknown as AutomaticSpeechRecognitionPipeline
    const audio = new Float32Array(31 * 16_000)
    await expect(transcribeSamples(pipeline, audio)).resolves.toBe("日文測試")
    expect(processor).toHaveBeenCalledWith(audio.subarray(0, 30 * 16_000))
    expect(model).toHaveBeenCalledOnce()
    expect(run).toHaveBeenCalledWith(audio, {
      language: "ja",
      task: "transcribe",
      chunk_length_s: 30,
      stride_length_s: 5,
    })
    for (const spy of dispose) expect(spy).toHaveBeenCalledOnce()
  })
})
