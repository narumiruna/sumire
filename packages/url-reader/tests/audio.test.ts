import { AsyncLocalStorage } from "node:async_hooks"
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  AudioMessageReader,
  DEFAULT_MODEL,
  encodeAudioMessage,
  MAX_CONTROL_BYTES,
  resolveAudioModel,
} from "../src/audio/protocol.js"
import {
  AudioTranscriberService,
  AudioTranscriptionError,
  closeAudioTranscriber,
  type TranscribeAudioFile,
  withAudioTranscriber,
} from "../src/audio.js"

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function wav(seconds: number): Buffer {
  const samples = Math.floor(16_000 * seconds)
  const bytes = Buffer.alloc(44 + samples * 2)
  bytes.write("RIFF", 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write("WAVEfmt ", 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16_000, 24)
  bytes.writeUInt32LE(32_000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write("data", 36)
  bytes.writeUInt32LE(samples * 2, 40)
  return bytes
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

interface FixtureResult {
  pid: number
  initializations: number
  jobs: number
  samples: number
}

let directory: string
let input: string
let entry: URL
let service: AudioTranscriberService

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sumire-asr-test-"))
  input = join(directory, "input.wav")
  await writeFile(input, wav(0.1))
  const child = join(directory, "fixture.mjs")
  await writeFile(
    child,
    `import { createInterface } from 'node:readline';
import { writeFileSync, existsSync } from 'node:fs';
process.on('SIGTERM', () => {});
process.on('disconnect', () => process.exit(0));
let job, phase, selected, initializations = 0, jobs = 0;
const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.type === 'dispose') {
    writeFileSync(${JSON.stringify(join(directory, "disposed"))}, 'disposed');
    process.exit(0);
  }
  if (message.type === 'transcribe') {
    job = message;
    writeFileSync(${JSON.stringify(join(directory, "state.json"))}, JSON.stringify({ ...job, pid: process.pid }));
    phase = 'model_load';
    send({ type: 'phase', phase });
  } else if (message.type === 'continue' && message.phase === phase) {
    if (job.model === 'fixture/phases' && !existsSync(${JSON.stringify(directory)} + '/' + phase)) process.exit(31);
    if (phase === 'model_load') {
      if (selected !== job.model) { selected = job.model; initializations++; }
      phase = 'inference';
      send({ type: 'phase', phase });
    } else {
      jobs++;
      if (job.model === 'fixture/stall') return;
      if (job.model === 'fixture/crash') process.exit(17);
      if (job.model === 'fixture/oversize') return process.stdout.write('x'.repeat(1048577));
      if (job.model === 'fixture/malformed') return process.stdout.write('not json\\n');
      if (job.model === 'fixture/failure') return send({ type: 'error', phase, kind: 'transcription_failed', stderr: '/private/token transcript' });
      if (job.model === 'fixture/missing') return send({ type: 'error', phase, kind: 'dependency_missing', dependency: '@huggingface/transformers' });
      if (job.model === 'fixture/empty') return send({ type: 'result', text: '  ' });
      send({ type: 'result', text: JSON.stringify({ pid: process.pid, initializations, jobs, samples: job.samples }) });
    }
  }
});
`,
  )
  entry = pathToFileURL(child)
  service = new AudioTranscriberService(entry)
})

afterEach(async () => {
  await service.close()
  await closeAudioTranscriber()
  await rm(directory, { recursive: true, force: true })
})

function transcribe(model = "tiny"): Promise<string> {
  return service.withTranscriber((run) => run(input, { maxDurationSeconds: 1, model }))
}

async function state(): Promise<{ pid: number; path: string }> {
  return JSON.parse(await readFile(join(directory, "state.json"), "utf8"))
}

describe("shared audio admission and inference process", () => {
  it("loads lazily and reuses one selected model and one child", async () => {
    const first: FixtureResult = JSON.parse(await transcribe())
    const second: FixtureResult = JSON.parse(await transcribe(DEFAULT_MODEL))
    expect(second).toMatchObject({ pid: first.pid, initializations: 1, jobs: 2, samples: 1600 })
    const changed: FixtureResult = JSON.parse(await transcribe("fixture/other"))
    expect(changed).toMatchObject({ pid: first.pid, initializations: 2 })
    const original: FixtureResult = JSON.parse(await transcribe())
    expect(original.initializations).toBe(3)
    await expect(access((await state()).path)).rejects.toThrow()
  })

  it("restores each request's async context when a warm child reports phases", async () => {
    const context = new AsyncLocalStorage<string>()
    const observed: string[] = []
    const run = (name: string) =>
      context.run(name, () =>
        service.withTranscriber((transcribe) =>
          transcribe(input, {
            maxDurationSeconds: 1,
            onPhase(phase) {
              observed.push(`${context.getStore()}:${phase}`)
            },
          }),
        ),
      )
    await run("url")
    await run("telegram")
    expect(observed).toEqual([
      "url:decode",
      "url:model_load",
      "url:inference",
      "telegram:decode",
      "telegram:model_load",
      "telegram:inference",
    ])
  })

  it("runs phase callbacks before child operations", async () => {
    const phases: string[] = []
    await service.withTranscriber((run) =>
      run(input, {
        maxDurationSeconds: 1,
        model: "fixture/phases",
        onPhase(phase) {
          phases.push(phase)
          if (phase !== "decode") {
            // This callback must finish before the parent sends the continuation.
            requirePhaseMarker(phase)
          }
        },
      }),
    )
    expect(phases).toEqual(["decode", "model_load", "inference"])
  })

  it("holds the shared slot through URL and Telegram download and cleanup", async () => {
    const cleanup = deferred()
    const entered = deferred()
    const events: string[] = []
    const url = withAudioTranscriber(async () => {
      events.push("url-download")
      entered.resolve()
      await cleanup.promise
      events.push("url-cleanup")
    })
    await entered.promise
    const telegram = withAudioTranscriber(async () => {
      events.push("telegram-download")
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(events).toEqual(["url-download"])
    cleanup.resolve()
    await Promise.all([url, telegram])
    expect(events).toEqual(["url-download", "url-cleanup", "telegram-download"])
  })

  it("cancels a queued caller before download without blocking later callers", async () => {
    const gate = deferred()
    const entered = deferred()
    const active = service.withTranscriber(async () => {
      entered.resolve()
      await gate.promise
    })
    await entered.promise
    const download = vi.fn()
    const controller = new AbortController()
    const reason = new Error("queued cancellation")
    const queued = service.withTranscriber(download, controller.signal)
    controller.abort(reason)
    await expect(queued).rejects.toBe(reason)
    expect(download).not.toHaveBeenCalled()
    const next = service.withTranscriber(async () => "next")
    gate.resolve()
    await active
    await expect(next).resolves.toBe("next")
  })

  it("preserves pre-aborted cancellation identity without starting work", async () => {
    const reason = new Error("cancelled")
    const operation = vi.fn()
    await expect(service.withTranscriber(operation, AbortSignal.abort(reason))).rejects.toBe(reason)
    expect(operation).not.toHaveBeenCalled()
  })

  it.each(["model_load", "inference"] as const)(
    "kills and awaits native closure on cancellation during %s, then restarts",
    async (cancelPhase) => {
      const controller = new AbortController()
      const reason = new Error("cancelled native work")
      const started = performance.now()
      const result = service.withTranscriber(
        (run) =>
          run(input, {
            maxDurationSeconds: 1,
            model: "fixture/stall",
            onPhase(phase) {
              if (phase === cancelPhase) controller.abort(reason)
            },
          }),
        controller.signal,
      )
      await expect(result).rejects.toBe(reason)
      const old = await state()
      expect(isAlive(old.pid)).toBe(false)
      expect(performance.now() - started).toBeGreaterThanOrEqual(190)
      await expect(access(old.path)).rejects.toThrow()
      const next: FixtureResult = JSON.parse(await transcribe())
      expect(next.pid).not.toBe(old.pid)
      expect(next.initializations).toBe(1)
    },
  )

  it("does not release admission until active process closure and adapter cleanup", async () => {
    const controller = new AbortController()
    const cleanup = deferred()
    const cleaning = deferred()
    const reason = new Error("abort")
    const first = service.withTranscriber(async (run) => {
      try {
        await run(input, {
          maxDurationSeconds: 1,
          model: "fixture/stall",
          signal: controller.signal,
          onPhase(phase) {
            if (phase === "inference") controller.abort(reason)
          },
        })
      } finally {
        expect(isAlive((await state()).pid)).toBe(false)
        cleaning.resolve()
        await cleanup.promise
      }
    })
    const rejected = expect(first).rejects.toBe(reason)
    await cleaning.promise
    const next = vi.fn(async () => "next")
    const queued = service.withTranscriber(next)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(next).not.toHaveBeenCalled()
    cleanup.resolve()
    await rejected
    await expect(queued).resolves.toBe("next")
  })

  it.each(["crash", "oversize", "malformed", "failure", "empty", "missing"])(
    "contains a child %s failure, removes PCM, and restarts",
    async (kind) => {
      const result = transcribe(`fixture/${kind}`)
      await expect(result).rejects.toMatchObject({
        kind:
          kind === "empty"
            ? "empty_content"
            : kind === "missing"
              ? "dependency_missing"
              : "transcription_failed",
        phase: "inference",
      })
      const previous = await state()
      expect(isAlive(previous.pid)).toBe(false)
      await expect(access(previous.path)).rejects.toThrow()
      const next: FixtureResult = JSON.parse(await transcribe())
      expect(next.pid).not.toBe(previous.pid)
    },
  )

  it("bounds decoded PCM independently of the 1MiB control channel", async () => {
    await writeFile(input, wav(20))
    const text = await service.withTranscriber((run) => run(input, { maxDurationSeconds: 20 }))
    expect(JSON.parse(text).samples).toBe(320_000)
  })

  it("rejects decoded duration overflow rather than silently truncating", async () => {
    await writeFile(input, wav(2))
    const error = await transcribe().catch((error: unknown) => error)
    expect(error).toMatchObject({ kind: "media_duration_limit", phase: "decode", limit: 1 })
    expect((error as AudioTranscriptionError).observed).toBeGreaterThan(1)
    await expect(access(join(directory, "state.json"))).rejects.toThrow()
  })

  it("rejects malformed media with safe facts only", async () => {
    await writeFile(input, "private-url secret-token raw-transcript")
    const error = await transcribe().catch((error: unknown) => error)
    expect(error).toBeInstanceOf(AudioTranscriptionError)
    expect(error).toMatchObject({ kind: "transcription_failed", phase: "decode" })
    expect(String(error)).not.toMatch(/private-url|secret-token|raw-transcript|input.wav/u)
  })

  it("rejects invalid model IDs without invoking a local model path", async () => {
    await expect(transcribe("/private/model")).rejects.toMatchObject({
      kind: "transcription_failed",
      phase: "model_load",
    })
  })

  it("rejects a retained transcribe function after its admission ends", async () => {
    let retained: TranscribeAudioFile | undefined
    await service.withTranscriber(async (run) => {
      retained = run
    })
    await expect(retained?.(input, { maxDurationSeconds: 1 })).rejects.toMatchObject({
      kind: "transcription_failed",
    })
  })

  it("disposes a cached child and rejects later admission", async () => {
    const result: FixtureResult = JSON.parse(await transcribe())
    await service.close()
    expect(isAlive(result.pid)).toBe(false)
    await expect(readFile(join(directory, "disposed"), "utf8")).resolves.toBe("disposed")
    await expect(transcribe()).rejects.toMatchObject({ kind: "transcription_failed" })
  })

  it("shutdown aborts admitted preparation before transcription starts", async () => {
    const admitted = deferred()
    const work = service.withTranscriber(async (_run, signal) => {
      admitted.resolve()
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    })
    const failure = expect(work).rejects.toBeInstanceOf(AudioTranscriptionError)
    await admitted.promise
    await service.close()
    await failure
  })

  it("shutdown cancels active and queued jobs and leaves no child", async () => {
    const inference = deferred()
    const active = service.withTranscriber((run) =>
      run(input, {
        model: "fixture/stall",
        maxDurationSeconds: 1,
        onPhase(phase) {
          if (phase === "inference") inference.resolve()
        },
      }),
    )
    const activeFailure = expect(active).rejects.toBeInstanceOf(AudioTranscriptionError)
    await inference.promise
    const operation = vi.fn()
    const queued = service.withTranscriber(operation)
    const queuedFailure = expect(queued).rejects.toBeInstanceOf(AudioTranscriptionError)
    await service.close()
    await Promise.all([activeFailure, queuedFailure])
    expect(operation).not.toHaveBeenCalled()
    expect(isAlive((await state()).pid)).toBe(false)
  })

  it("does not keep a standalone process alive when inference is idle", async () => {
    const script = join(directory, "cli.mjs")
    await writeFile(
      script,
      `import { AudioTranscriberService } from ${JSON.stringify(new URL("../dist/audio.js", import.meta.url).href)};
const service = new AudioTranscriberService(new URL(${JSON.stringify(entry.href)}));
await service.withTranscriber(run => run(${JSON.stringify(input)}, { maxDurationSeconds: 1 }));
console.log('finished');
`,
    )
    const cli = spawn(process.execPath, [script], {
      stdio: ["ignore", "pipe", "pipe"],
      signal: AbortSignal.timeout(5000),
    })
    let output = ""
    cli.stdout.on("data", (bytes: Buffer) => {
      output += bytes.toString()
    })
    const code = await new Promise((resolve, reject) => {
      cli.on("error", reject)
      cli.on("close", resolve)
    })
    expect(code).toBe(0)
    expect(output).toBe("finished\n")
    await vi.waitFor(async () => expect(isAlive((await state()).pid)).toBe(false))
  })

  it("the production child exits on parent disconnect without loading models", async () => {
    const child = spawn(
      process.execPath,
      [new URL("../dist/audio/child.js", import.meta.url).pathname],
      {
        stdio: ["pipe", "pipe", "ignore", "ipc"],
      },
    )
    const exited = new Promise((resolve) => child.once("exit", resolve))
    child.disconnect()
    try {
      await expect(exited).resolves.toBe(0)
      expect(isAlive(child.pid as number)).toBe(false)
    } finally {
      child.stdin?.destroy()
      child.stdout?.destroy()
      child.kill("SIGKILL")
    }
  })
})

// The fixture checks marker existence before each simulated native operation.
function requirePhaseMarker(phase: string): void {
  writeFileSync(join(directory, phase), "confirmed")
}

describe("bounded audio control protocol", () => {
  it("maps tiny to the pinned model and preserves full Hub IDs", () => {
    expect(resolveAudioModel("tiny")).toBe(DEFAULT_MODEL)
    expect(resolveAudioModel("example/whisper-small")).toBe("example/whisper-small")
  })

  it("accepts fragmented frames and multiple frames", () => {
    const reader = new AudioMessageReader()
    const receive = vi.fn()
    reader.push(Buffer.from('{"type":'), receive)
    reader.push(Buffer.from('"phase"}\n{"type":"result"}\n'), receive)
    expect(receive.mock.calls).toEqual([[{ type: "phase" }], [{ type: "result" }]])
  })

  it("bounds both fragmented input and encoded output", () => {
    const reader = new AudioMessageReader()
    reader.push(Buffer.alloc(MAX_CONTROL_BYTES, 32), vi.fn())
    expect(() => reader.push(Buffer.from("\n"), vi.fn())).toThrow(AudioTranscriptionError)
    expect(() => encodeAudioMessage({ text: "x".repeat(MAX_CONTROL_BYTES) })).toThrow(
      AudioTranscriptionError,
    )
  })
})
