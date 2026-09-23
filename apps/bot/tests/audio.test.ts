import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, it, vi } from "vitest"

import { promptWithAudioContext, TelegramAudioTranscriber } from "../src/telegram/audio.js"
import { audioReferences } from "../src/telegram/messages.js"

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
    let directory = ""
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      const audioPath = args[0] ?? ""
      directory = join(audioPath, "..")
      expect(await readFile(audioPath)).toEqual(Buffer.from("audio bytes"))
      await writeFile(join(directory, "input.txt"), "a".repeat(15))
      return { stdout: "", stderr: "" }
    })
    const transcriber = new TelegramAudioTranscriber({
      maxConcurrency: 1,
      timeoutMs: 1000,
      maxChars: 10,
      run,
    })
    await expect(
      transcriber.transcribe(
        async () => Buffer.from("audio bytes"),
        () => true,
      ),
    ).resolves.toBe(`${"a".repeat(10)}\n[音訊逐字稿已截斷]`)
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0]?.[0]).toBe("whisper")
    await expect(readFile(join(directory, "input.txt"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("does not download queued audio after cancellation and cleans up after failure", async () => {
    let finish = () => {}
    let directory = ""
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      directory = join(args[0] ?? "", "..")
      await pending
      throw new Error("Whisper failed")
    })
    const transcriber = new TelegramAudioTranscriber({
      maxConcurrency: 1,
      timeoutMs: 1_000,
      maxChars: 100,
      run,
    })
    const first = transcriber.transcribe(
      async () => Buffer.from("a"),
      () => true,
    )
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce())
    const download = vi.fn(async () => Buffer.from("b"))
    const second = transcriber.transcribe(download, () => false)
    finish()
    await expect(first).rejects.toThrow("Whisper failed")
    await expect(second).resolves.toBe("")
    expect(download).not.toHaveBeenCalled()
    await expect(readFile(join(directory, "input.audio"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})
