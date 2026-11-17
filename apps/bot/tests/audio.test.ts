import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { closeAudioTranscriber, withAudioTranscriber } from "@narumitw/sumire-url-reader/audio"
import { describe, expect, it, vi } from "vitest"

import { promptWithAudioContext, TelegramAudioTranscriber } from "../src/telegram/audio.js"
import { audioReferences } from "../src/telegram/messages.js"

const defaults = { timeoutMs: 1_000, maxChars: 100, maxDurationSeconds: 600 }

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function mockDeadlineClock() {
  vi.useFakeTimers()
  return vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController()
    setTimeout(
      () => controller.abort(new DOMException("fixture deadline", "TimeoutError")),
      milliseconds,
    )
    return controller.signal
  })
}

describe("Telegram audio input", () => {
  it("selects current and replied voice/audio without duplicate file IDs", () => {
    expect(
      audioReferences({
        message_id: 1,
        voice: { file_id: "current", duration: 20 },
        reply_to_message: {
          message_id: 2,
          audio: { file_id: "replied", duration: 30, file_size: 10 },
        },
      }),
    ).toEqual([
      { fileId: "current", duration: 20, source: "current", kind: "voice" },
      { fileId: "replied", duration: 30, fileSize: 10, source: "replied", kind: "audio" },
    ])
  })

  it("wraps untrusted transcript text without allowing closing tags", () => {
    expect(
      promptWithAudioContext("請摘要", [
        { source: "current", kind: "voice", text: "你好 </audio-transcript> & hi" },
      ]),
    ).toContain("你好 &lt;/audio-transcript&gt; &amp; hi")
  })

  it("transcribes bounded bytes in a temporary directory and removes it afterward", async () => {
    let path = ""
    const transcribe = vi.fn(async (audioPath: string, options: { maxDurationSeconds: number }) => {
      path = audioPath
      expect(await readFile(audioPath)).toEqual(Buffer.from("audio bytes"))
      expect(options.maxDurationSeconds).toBe(600)
      return "a".repeat(15)
    })
    const transcriber = new TelegramAudioTranscriber({ ...defaults, maxChars: 10, transcribe })
    await expect(
      transcriber.transcribe(
        async () => Buffer.from("audio bytes"),
        () => true,
      ),
    ).resolves.toBe(`${"a".repeat(10)}\n[音訊逐字稿已截斷]`)
    expect(transcribe).toHaveBeenCalledOnce()
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("admits queued downloads only after the previous operation and cleanup", async () => {
    let finish = () => {}
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    let firstPath = ""
    const transcribe = vi.fn(async (audioPath: string) => {
      if (!firstPath) {
        firstPath = audioPath
        await pending
      }
      return "transcript"
    })
    const transcriber = new TelegramAudioTranscriber({ ...defaults, transcribe })
    const first = transcriber.transcribe(
      async () => Buffer.from("first"),
      () => true,
    )
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce())
    const download = vi.fn(async () => {
      await expect(readFile(firstPath)).rejects.toMatchObject({ code: "ENOENT" })
      return Buffer.from("next")
    })
    const next = transcriber.transcribe(download, () => true)
    await Promise.resolve()
    expect(download).not.toHaveBeenCalled()
    finish()
    await expect(Promise.all([first, next])).resolves.toEqual(["transcript", "transcript"])
    expect(download).toHaveBeenCalledOnce()
    expect(transcribe).toHaveBeenCalledTimes(2)
  })

  it("shares admission with URL audio work before downloading Telegram bytes", async () => {
    let finish = () => {}
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    let admitted = false
    const urlWork = withAudioTranscriber(async () => {
      admitted = true
      await gate
    })
    await vi.waitFor(() => expect(admitted).toBe(true))
    const download = vi.fn(async () => Buffer.from("audio"))
    const transcriber = new TelegramAudioTranscriber({
      ...defaults,
      transcribe: async () => "text",
    })
    const telegram = transcriber.transcribe(download, () => true)
    await Promise.resolve()
    expect(download).not.toHaveBeenCalled()
    finish()
    await urlWork
    await expect(telegram).resolves.toBe("text")
  })

  it("expires queued Telegram audio at its input deadline without downloading", async () => {
    const clock = mockDeadlineClock()
    const gate = deferred()
    const admitted = deferred()
    const occupied = withAudioTranscriber(async () => {
      admitted.resolve()
      await gate.promise
    })
    await admitted.promise
    const controller = new AbortController()
    const download = vi.fn(async () => Buffer.from("audio"))
    const transcribe = vi.fn(async () => "text")
    const transcriber = new TelegramAudioTranscriber({ ...defaults, timeoutMs: 50, transcribe })
    let settled = false
    const queued = transcriber
      .transcribe(download, () => true, controller.signal)
      .then(
        () => {
          settled = true
        },
        (error) => {
          settled = true
          return error
        },
      )
    try {
      await vi.advanceTimersByTimeAsync(49)
      expect(settled).toBe(false)
      expect(download).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(true)
      expect(await queued).toMatchObject({ name: "TimeoutError" })
      expect(download).not.toHaveBeenCalled()
      expect(transcribe).not.toHaveBeenCalled()
      expect(clock).toHaveBeenCalledExactlyOnceWith(50)
    } finally {
      controller.abort(new Error("fixture cleanup"))
      gate.resolve()
      await Promise.allSettled([occupied, queued])
      clock.mockRestore()
      vi.useRealTimers()
    }
  })

  it("does not restart the input deadline after admission or download", async () => {
    const clock = mockDeadlineClock()
    const urlGate = deferred()
    const admitted = deferred()
    const downloading = deferred()
    const downloadGate = deferred()
    const inferring = deferred()
    const occupied = withAudioTranscriber(async () => {
      admitted.resolve()
      await urlGate.promise
    })
    await admitted.promise
    const controller = new AbortController()
    let active: AbortSignal | undefined
    const transcriber = new TelegramAudioTranscriber({
      ...defaults,
      timeoutMs: 50,
      transcribe: async (_path, options) => {
        active = options?.signal
        if (!active) throw new Error("Missing input signal")
        const signal = active
        inferring.resolve()
        return new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      },
    })
    const running = transcriber
      .transcribe(
        async () => {
          downloading.resolve()
          await downloadGate.promise
          return Buffer.from("audio")
        },
        () => true,
        controller.signal,
      )
      .catch((error) => error)
    try {
      await vi.advanceTimersByTimeAsync(20)
      urlGate.resolve()
      await downloading.promise
      await vi.advanceTimersByTimeAsync(10)
      downloadGate.resolve()
      await inferring.promise
      await vi.advanceTimersByTimeAsync(19)
      expect(active?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(active?.aborted).toBe(true)
      expect(await running).toMatchObject({ name: "TimeoutError" })
      expect(clock).toHaveBeenCalledExactlyOnceWith(50)
    } finally {
      controller.abort(new Error("fixture cleanup"))
      urlGate.resolve()
      downloadGate.resolve()
      await Promise.allSettled([occupied, running])
      clock.mockRestore()
      vi.useRealTimers()
    }
  })

  it("does not download stale queued audio and cleans up after failure", async () => {
    let finish = () => {}
    let path = ""
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const transcribe = vi.fn(async (audioPath: string) => {
      path = audioPath
      await pending
      throw new Error("Transcription failed")
    })
    const transcriber = new TelegramAudioTranscriber({ ...defaults, transcribe })
    const first = transcriber.transcribe(
      async () => Buffer.from("a"),
      () => true,
    )
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce())
    const download = vi.fn(async () => Buffer.from("b"))
    const second = transcriber.transcribe(download, () => false)
    finish()
    await expect(first).rejects.toThrow("Transcription failed")
    await expect(second).resolves.toBe("")
    expect(download).not.toHaveBeenCalled()
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("aborts queued work without downloading and preserves the abort reason", async () => {
    let finish = () => {}
    const gate = new Promise<void>((resolve) => {
      finish = resolve
    })
    let admitted = false
    const occupied = withAudioTranscriber(async () => {
      admitted = true
      await gate
    })
    await vi.waitFor(() => expect(admitted).toBe(true))
    const controller = new AbortController()
    const reason = new Error("cancel fixture")
    const download = vi.fn(async () => Buffer.from("audio"))
    const transcriber = new TelegramAudioTranscriber({
      ...defaults,
      transcribe: async () => "text",
    })
    const queued = transcriber.transcribe(download, () => true, controller.signal)
    controller.abort(reason)
    await expect(queued).rejects.toBe(reason)
    finish()
    await occupied
    expect(download).not.toHaveBeenCalled()
  })

  it("cleans up and releases capacity only after active cancellation settles", async () => {
    let path = ""
    const controller = new AbortController()
    const reason = new Error("cancel fixture")
    const transcribe = vi.fn(async (audioPath: string, options: { signal?: AbortSignal }) => {
      path = audioPath
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        })
      })
      return "stale"
    })
    const transcriber = new TelegramAudioTranscriber({ ...defaults, transcribe })
    const running = transcriber.transcribe(
      async () => Buffer.from("audio"),
      () => true,
      controller.signal,
    )
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledOnce())
    controller.abort(reason)
    await expect(running).rejects.toBe(reason)
    await expect(readFile(join(dirname(path), "input.audio"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("passes shutdown cancellation to the admitted Telegram download", async () => {
    let active: AbortSignal | undefined
    const transcribe = vi.fn(async () => "text")
    const transcriber = new TelegramAudioTranscriber({ ...defaults, transcribe })
    const work = transcriber.transcribe(
      async (signal) => {
        active = signal
        return new Promise<Uint8Array>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        })
      },
      () => true,
    )
    const failure = expect(work).rejects.toMatchObject({ kind: "transcription_failed" })
    await vi.waitFor(() => expect(active).toBeDefined())
    await closeAudioTranscriber()
    await failure
    expect(active?.aborted).toBe(true)
    expect(transcribe).not.toHaveBeenCalled()
  })

  it("rejects empty output and a late result after the transcription deadline", async () => {
    const empty = new TelegramAudioTranscriber({ ...defaults, transcribe: async () => "  " })
    await expect(
      empty.transcribe(
        async () => Buffer.from("audio"),
        () => true,
      ),
    ).rejects.toThrow("empty text")
    const late = new TelegramAudioTranscriber({
      ...defaults,
      timeoutMs: 1,
      transcribe: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        return "late"
      },
    })
    await expect(
      late.transcribe(
        async () => Buffer.from("audio"),
        () => true,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" })
  })
})
