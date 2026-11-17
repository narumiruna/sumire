import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { loadWhisperPipeline } from "../src/audio/model.js"
import { DEFAULT_MODEL, DEFAULT_REVISION, resolveAudioModel } from "../src/audio/protocol.js"

const mocks = vi.hoisted(() => ({
  model: vi.fn(),
  extractor: vi.fn(),
  tokenizer: vi.fn(),
  processor: vi.fn(),
  pipeline: vi.fn(),
  env: { cacheDir: "", allowLocalModels: true },
}))
vi.mock("@huggingface/transformers", () => ({
  env: mocks.env,
  WhisperForConditionalGeneration: { from_pretrained: mocks.model },
  WhisperFeatureExtractor: { from_pretrained: mocks.extractor },
  WhisperTokenizer: class {
    constructor(...args: unknown[]) {
      mocks.tokenizer(...args)
    }
  },
  WhisperProcessor: class {
    constructor(...args: unknown[]) {
      mocks.processor(...args)
    }
  },
  AutomaticSpeechRecognitionPipeline: class {
    constructor(...args: unknown[]) {
      mocks.pipeline(...args)
    }
  },
}))

let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sumire-audio-model-test-"))
  vi.stubEnv("XDG_CACHE_HOME", directory)
  mocks.model.mockResolvedValue({})
  mocks.extractor.mockResolvedValue({})
})
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
  await rm(directory, { recursive: true, force: true })
})

describe("pinned Whisper components", () => {
  it("uses only versioned assets and reuses the tokenizer cache without remote discovery", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain(`/resolve/${DEFAULT_REVISION}/`)
      return Response.json({ asset: String(url).endsWith("tokenizer.json") ? "tokens" : "config" })
    })
    vi.stubGlobal("fetch", fetch)
    await loadWhisperPipeline(DEFAULT_MODEL)
    expect(mocks.model).toHaveBeenCalledWith(
      DEFAULT_MODEL,
      expect.objectContaining({
        revision: DEFAULT_REVISION,
        dtype: "q8",
        device: "cpu",
        session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
      }),
    )
    expect(mocks.extractor).toHaveBeenCalledWith(
      DEFAULT_MODEL,
      expect.objectContaining({ revision: DEFAULT_REVISION }),
    )
    expect(mocks.tokenizer).toHaveBeenCalledWith({ asset: "tokens" }, { asset: "config" })
    expect(mocks.pipeline).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledTimes(2)
    fetch.mockRejectedValue(new Error("network is disabled"))
    await loadWhisperPipeline(DEFAULT_MODEL)
    expect(fetch).toHaveBeenCalledTimes(2)
    const cached = join(
      directory,
      "transformers",
      DEFAULT_MODEL,
      DEFAULT_REVISION,
      "tokenizer.json",
    )
    expect(JSON.parse(await readFile(cached, "utf8"))).toEqual({ asset: "tokens" })
    expect(mocks.env.allowLocalModels).toBe(false)
  })

  it("does not apply the default model revision to overrides", async () => {
    const fetch = vi.fn(async (_url: string | URL | Request) => Response.json({}))
    vi.stubGlobal("fetch", fetch)
    await loadWhisperPipeline("example/whisper-small")
    expect(mocks.model).toHaveBeenCalledWith(
      "example/whisper-small",
      expect.objectContaining({ revision: "main" }),
    )
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(
      expect.arrayContaining([
        "https://huggingface.co/example/whisper-small/resolve/main/tokenizer.json",
        "https://huggingface.co/example/whisper-small/resolve/main/tokenizer_config.json",
      ]),
    )
  })

  it("bounds streamed tokenizer assets even without a content length", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(8 * 1024 * 1024))
                controller.enqueue(new Uint8Array(1))
                controller.close()
              },
            }),
          ),
      ),
    )
    await expect(loadWhisperPipeline(DEFAULT_MODEL)).rejects.toThrow(
      "Tokenizer asset exceeds limit",
    )
    expect(mocks.tokenizer).not.toHaveBeenCalled()
  })

  it.each(["../model", "org/..", ".cache/model", "/absolute/model", "org/model/path"])(
    "rejects a model ID that can escape cache scope: %s",
    (model) => {
      expect(() => resolveAudioModel(model)).toThrow()
    },
  )
})
