import { randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers"
import { DEFAULT_MODEL, DEFAULT_REVISION, resolveAudioModel } from "./protocol.js"

const MAX_TOKENIZER_BYTES = 8 * 1024 * 1024

async function tokenizerBytes(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = []
  let bytes = 0
  for await (const part of stream) {
    bytes += part.byteLength
    if (bytes > MAX_TOKENIZER_BYTES) throw new Error("Tokenizer asset exceeds limit")
    parts.push(part)
  }
  return Buffer.concat(parts)
}

/** Read a versioned tokenizer asset without the 4.3.2 unversioned discovery request. */
async function tokenizerJson(
  cache: string,
  model: string,
  revision: string,
  filename: "tokenizer.json" | "tokenizer_config.json",
): Promise<unknown> {
  const path = join(cache, model, ...(revision === "main" ? [] : [revision]), filename)
  try {
    const cached = await tokenizerBytes(createReadStream(path))
    return JSON.parse(cached.toString("utf8"))
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
  }
  const response = await fetch(`https://huggingface.co/${model}/resolve/${revision}/${filename}`, {
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok || !response.body) throw new Error("Tokenizer asset unavailable")
  const content = await tokenizerBytes(response.body)
  const parsed: unknown = JSON.parse(content.toString("utf8"))
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
  return parsed
}

/** Construct only Whisper components; discovery must not fetch mutable main metadata. */
export async function loadWhisperPipeline(
  model: string,
): Promise<AutomaticSpeechRecognitionPipeline> {
  model = resolveAudioModel(model)
  const {
    env,
    WhisperForConditionalGeneration,
    WhisperTokenizer,
    WhisperFeatureExtractor,
    WhisperProcessor,
    AutomaticSpeechRecognitionPipeline,
  } = await import("@huggingface/transformers")
  const cache = resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "transformers")
  env.cacheDir = cache
  env.allowLocalModels = false
  const revision = model === DEFAULT_MODEL ? DEFAULT_REVISION : "main"
  const options = {
    revision,
    dtype: "q8" as const,
    device: "cpu" as const,
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
  }
  const [whisper, tokenizerData, tokenizerConfig, featureExtractor] = await Promise.all([
    WhisperForConditionalGeneration.from_pretrained(model, options),
    tokenizerJson(cache, model, revision, "tokenizer.json"),
    tokenizerJson(cache, model, revision, "tokenizer_config.json"),
    WhisperFeatureExtractor.from_pretrained(model, options),
  ])
  const tokenizer = new WhisperTokenizer(tokenizerData, tokenizerConfig)
  const processor = new WhisperProcessor(
    {},
    { tokenizer, feature_extractor: featureExtractor },
    null,
  )
  return new AutomaticSpeechRecognitionPipeline({
    task: "automatic-speech-recognition",
    model: whisper,
    tokenizer,
    processor,
  })
}
