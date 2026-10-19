import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import { type Model, Type } from "@earendil-works/pi-ai"
import { createModels } from "@earendil-works/pi-ai/models"
import { CodemodeSandbox } from "@earendil-works/pi-codemode"
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  type JsonObject,
  MemoryStorage,
  type NestedToolExecutionResult,
  type ToolRegistration,
  ToolResultEntry,
  ToolTask,
} from "@earendil-works/pi-durable"
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode"
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  adaptTool,
  durableToolResult,
  isCodemodeCallable,
  type NativeTool,
  nativeCodingTools,
} from "../src/agent/durable/tools.js"

const usage = {
  input: 1,
  output: 2,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 3,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function setup(tools: ToolRegistration[] = []) {
  const cwd = await mkdtemp(path.join(tmpdir(), "sumire-native-tools-"))
  cleanups.push(() => rm(cwd, { recursive: true, force: true }))
  const env = new NodeExecutionEnv({ cwd, shellEnv: { ENV_ONLY_SECRET: "excluded" } })
  cleanups.push(() => env.cleanup(context))
  const registry = createRegistry()
  registry.install(defineExtension({ name: "fixture", tools }))
  const models = createModels()
  const reports: unknown[] = []
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, env: () => env, onReport: (report) => reports.push(report) },
    context,
  )
  cleanups.push(() => harness.close(context))
  const root = await harness.root(context)
  let sequence = 0
  async function run(name: string, args: JsonObject = {}) {
    const callId = `call-${++sequence}`
    const taskId = await root.commit(async (tx) => {
      const assistant = await tx.appendEntry(root.id, {
        kind: "pi.assistant",
        model: [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: callId, name, arguments: args }],
            api: "openai-completions",
            provider: "fixture",
            model: "fixture",
            usage,
            stopReason: "toolUse",
            timestamp: 1,
          },
        ],
      })
      return tx.createTask(
        ToolTask,
        { kind: "model", assistant: assistant.id, callId },
        { conversationId: root.id, ownership: { kind: "conversation" } },
      )
    }, context)
    const settled = await harness.waitForTask(taskId, context)
    const outcome = settled.state.outcome
    if (outcome.status !== "completed" || outcome.result.kind !== "model") {
      throw new Error(`Tool task did not complete: ${JSON.stringify(outcome)}`)
    }
    const { entryId, control } = outcome.result
    const entry = await root.commit((tx) => tx.entry(ToolResultEntry, entryId), context)
    const message = entry?.model?.[0]
    if (message?.role !== "toolResult") throw new Error("Missing tool result")
    return { message, entry, control }
  }
  async function nested(name: string, args: JsonObject = {}) {
    let result: NestedToolExecutionResult | undefined
    registry.install(
      defineExtension({
        name: "probe",
        tools: [
          defineTool({
            name: "probe",
            description: "Call a tool through the native harness",
            parameters: Type.Object({}),
            async execute(_args, api, ctx) {
              result = await api.executeTool(name, args, ctx)
              // The nested task owns its usage. Do not pass it on here.
              return { output: [{ type: "text", text: "probe completed" }] }
            },
          }),
        ],
      }),
    )
    await run("probe")
    if (!result) throw new Error("Missing nested result")
    return result
  }
  function codemode() {
    const sandbox = new CodemodeSandbox()
    cleanups.push(() => sandbox.close())
    registry.install(createCodemodeExtension({ sandbox, models: false }))
  }
  return { cwd, env, registry, models, harness, root, reports, run, nested, codemode }
}

function capability(overrides: Partial<NativeTool> = {}): NativeTool {
  return {
    name: "capability",
    label: "Capability",
    description: "Typed capability fixture",
    parameters: Type.Object({ value: Type.Number() }),
    outputSchema: Type.Object({ value: Type.Number() }),
    async execute(_id, args) {
      return {
        content: [{ type: "text", text: "model output" }],
        structuredContent: { value: (args as { value: number }).value },
        details: { ui: "details" },
        usage,
      }
    },
    ...overrides,
  }
}

const textOf = (content: { type: string; text?: string }[]) =>
  content.map((block) => block.text ?? "").join("\n")

// A small uncompressed BMP exercises Photon's conversion and resize path.
function bmp(width: number, height: number) {
  const rowBytes = Math.ceil((width * 3) / 4) * 4
  const bytes = Buffer.alloc(54 + rowBytes * height, 255)
  bytes.fill(0, 0, 54)
  bytes.write("BM")
  bytes.writeUInt32LE(bytes.length, 2)
  bytes.writeUInt32LE(54, 10)
  bytes.writeUInt32LE(40, 14)
  bytes.writeInt32LE(width, 18)
  bytes.writeInt32LE(height, 22)
  bytes.writeUInt16LE(1, 26)
  bytes.writeUInt16LE(24, 28)
  bytes.writeUInt32LE(rowBytes * height, 34)
  return bytes
}

const model: Model<"openai-completions"> = {
  id: "fixture",
  name: "Fixture",
  api: "openai-completions",
  provider: "fixture",
  baseUrl: "https://example.com",
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  reasoning: false,
  contextWindow: 100_000,
  maxTokens: 1000,
}

describe("durable tool results", () => {
  it.each([false, true])("preserves typed channels and failure status %s", (isError) => {
    const content = [
      { type: "text" as const, text: "Tool output" },
      { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" },
    ]
    expect(
      durableToolResult({
        content,
        structuredContent: { value: 42 },
        details: { ui: true },
        isError,
        usage,
      }),
    ).toEqual({
      output: content,
      structuredOutput: { value: 42 },
      details: { ui: true },
      isError,
      usage,
    })
  })

  it("removes undefined fields and maps early termination", () => {
    expect(durableToolResult({ content: [], details: undefined, terminate: true })).toEqual({
      output: [],
      control: { terminate: true },
    })
  })
})

describe("capability adapter", () => {
  it.each([false, true])(
    "keeps direct and nested typed channels separate (error=%s)",
    async (isError) => {
      const tool = capability()
      const execute = tool.execute
      tool.execute = async (...args) => ({ ...(await execute(...args)), isError, terminate: true })
      const fixture = await setup([adaptTool(tool)])
      const direct = await fixture.run(tool.name, { value: 42 })
      expect(direct.message).toMatchObject({
        content: [{ type: "text", text: "model output" }],
        details: { ui: "details" },
        isError,
        usage,
      })
      expect(direct.control).toEqual({ terminate: true })
      expect(JSON.stringify(direct.entry)).not.toContain('"value":42')
      const nested = await fixture.nested(tool.name, { value: 43 })
      expect(nested).toMatchObject({
        structuredOutput: { value: 43 },
        details: { ui: "details" },
        isError,
        usage,
      })
      expect(nested).not.toHaveProperty("output")
      expect(nested).not.toHaveProperty("control")
      expect((await fixture.harness.usage(context)).tools.capability?.totalTokens).toBe(6)
      expect(fixture.reports).toEqual([])
    },
  )

  it.each([false, true])(
    "passes typed capability data through native codemode (error=%s)",
    async (isError) => {
      const tool = capability()
      const execute = tool.execute
      tool.execute = async (...args) => ({ ...(await execute(...args)), isError })
      const fixture = await setup([adaptTool(tool)])
      fixture.codemode()
      const result = await fixture.run("codemode", {
        code: "const result = await tools.capability({value: 7}); text(result.value);",
      })
      expect(result.message.isError).toBe(false)
      expect(textOf(result.message.content)).toContain("7")
      expect(textOf(result.message.content)).not.toContain("model output")
      expect((await fixture.harness.usage(context)).tools.capability?.totalTokens).toBe(3)
      expect(fixture.reports).toEqual([])
    },
  )

  it("uses harness argument preparation and validation exactly once per call", async () => {
    const prepareArguments = vi.fn((args: unknown) => ({
      value: Number((args as { value: unknown }).value),
    }))
    const tool = capability({ prepareArguments })
    const execute = vi.spyOn(tool, "execute")
    const fixture = await setup([adaptTool(tool)])
    expect((await fixture.run(tool.name, { value: "4" })).message.isError).toBe(false)
    expect((await fixture.nested(tool.name, { value: "5" })).structuredOutput).toEqual({ value: 5 })
    expect(prepareArguments).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledTimes(2)
    expect((await fixture.run(tool.name, { value: "invalid" })).message.isError).toBe(true)
    expect((await fixture.nested(tool.name, { value: "invalid" })).isError).toBe(true)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it.each(["missing", "invalid", "undeclared"] as const)(
    "lets harness reject %s structured success output",
    async (mode) => {
      const fixture = await setup([
        adaptTool(
          capability({
            outputSchema: mode === "undeclared" ? undefined : Type.Object({ value: Type.Number() }),
            async execute() {
              return {
                content: [{ type: "text", text: "model output" }],
                details: undefined,
                ...(mode === "missing" ? {} : { structuredContent: { value: "wrong" } }),
              }
            },
          }),
        ),
      ])
      expect((await fixture.run("capability", { value: 1 })).message.isError).toBe(false)
      expect(fixture.reports).toHaveLength(1)
      const nested = await fixture.nested("capability", { value: 1 })
      expect(nested.isError).toBe(true)
      expect(nested.structuredOutput).toBe(mode === "undeclared" ? "model output" : undefined)
      expect(nested.diagnostics).toContainEqual(
        expect.objectContaining({ code: "invalid_structured_output" }),
      )
    },
  )

  it("allows schema errors without data and preserves schema-less text errors", async () => {
    const fixture = await setup([
      adaptTool(
        capability({
          async execute() {
            return {
              content: [{ type: "text", text: "failure" }],
              details: undefined,
              isError: true,
            }
          },
        }),
      ),
    ])
    const nested = await fixture.nested("capability", { value: 1 })
    expect(nested).toMatchObject({
      isError: true,
      diagnostics: [expect.objectContaining({ code: "tool_error", message: "failure" })],
    })
    expect(nested.structuredOutput).toBeUndefined()
    fixture.registry.install(
      defineExtension({
        name: "fixture",
        tools: [
          adaptTool(
            capability({
              outputSchema: undefined,
              async execute() {
                return {
                  content: [{ type: "text", text: "failure" }],
                  details: undefined,
                  isError: true,
                }
              },
            }),
          ),
        ],
      }),
    )
    expect(await fixture.nested("capability", { value: 1 })).toMatchObject({
      isError: true,
      structuredOutput: "failure",
    })
  })

  it.each(["read", "write", "edit", "bash", "publish"])(
    "defaults external %s replay to unsafe",
    (name) => {
      expect(adaptTool(capability({ name })).replay).toBe("unsafe")
    },
  )
})

describe("tool visibility", () => {
  it.each([
    [undefined, true, true],
    ["direct", true, true],
    ["deferred", false, true],
    ["codemode", false, true],
    ["model-only", true, false],
    ["hidden", false, false],
  ] as const)(
    "enforces exposure %s for model and nested calls",
    async (exposure, offered, callable) => {
      const tool = capability({ exposure })
      const execute = vi.spyOn(tool, "execute")
      const registration = adaptTool(tool)
      const fixture = await setup([registration])
      const agent = await fixture.root.agent(context)
      expect(agent.tools.some((tool) => tool.name === "capability")).toBe(offered)
      expect(agent.callable.some((tool) => tool.name === "capability")).toBe(callable)
      expect(isCodemodeCallable({ exposure })).toBe(callable)
      expect((await fixture.nested("capability", { value: 1 })).isError).toBe(!callable)
      expect((await fixture.run("capability", { value: 1 })).message.isError).toBe(!offered)
      expect(execute).toHaveBeenCalledTimes(Number(offered) + Number(callable))
      if (exposure === "deferred") {
        await fixture.root.configure({ modelTools: [registration] }, context)
        expect((await fixture.root.agent(context)).tools.map((tool) => tool.name)).toContain(
          "capability",
        )
      }
    },
  )
})

describe("native coding tools", () => {
  it("uses native replay defaults, cwd, file mutations, and a restricted shell environment", async () => {
    vi.stubEnv("PROCESS_ONLY_SECRET", "excluded")
    vi.stubEnv("BASH_ENV", "/not/a/valid/shell/startup")
    const tools = await nativeCodingTools({
      PATH: process.env.PATH,
      ALLOWED: "included",
      OMIT: undefined,
    })
    expect(tools.map(({ name, replay }) => ({ name, replay }))).toEqual([
      { name: "read", replay: "safe" },
      { name: "bash", replay: "unsafe" },
      { name: "edit", replay: "unsafe" },
      { name: "write", replay: "unsafe" },
    ])
    const fixture = await setup(tools)
    expect(
      (await fixture.run("write", { path: "file.txt", content: "before" })).message.isError,
    ).toBe(false)
    expect(
      (
        await fixture.run("edit", {
          path: "file.txt",
          edits: [{ oldText: "before", newText: "after" }],
        })
      ).message.isError,
    ).toBe(false)
    expect(await readFile(path.join(fixture.cwd, "file.txt"), "utf8")).toBe("after")
    expect((await fixture.nested("read", { path: "file.txt" })).structuredOutput).toBe("after")
    const shell = await fixture.nested("bash", {
      command:
        'printf "%s|%s|%s|%s|%s" "$PWD" "$ALLOWED" "$PROCESS_ONLY_SECRET" "$ENV_ONLY_SECRET" "$BASH_ENV"',
    })
    expect(shell).toMatchObject({
      isError: false,
      structuredOutput: {
        output: `${await realpath(fixture.cwd)}|included|||`,
        truncated: false,
        exitCode: 0,
      },
    })
  })

  it("keeps native Bash camelCase fields, error data, bounded tails, and spill paths", async () => {
    const fixture = await setup(await nativeCodingTools())
    const failure = await fixture.nested("bash", { command: "printf failure; exit 7" })
    expect(failure).toMatchObject({
      isError: true,
      structuredOutput: { output: "failure", truncated: false, exitCode: 7 },
    })
    const result = await fixture.nested("bash", {
      command: "i=0; while [ $i -lt 3000 ]; do printf 'line-%s\\n' $i; i=$((i+1)); done",
    })
    const value = result.structuredOutput as {
      output: string
      truncated: boolean
      fullOutputPath: string
      exitCode: number
    }
    expect(value.truncated).toBe(true)
    expect(value.exitCode).toBe(0)
    expect(value.output).toContain("line-2999")
    expect(value.output).not.toContain("line-0\n")
    expect(value.output.split("\n").length).toBeLessThanOrEqual(2001)
    expect(Buffer.byteLength(value.output)).toBeLessThanOrEqual(50 * 1024)
    expect(await readFile(value.fullOutputPath, "utf8")).toContain("line-0\n")
    cleanups.push(() => rm(value.fullOutputPath, { force: true }))
    expect(value).not.toHaveProperty("exit_code")
    expect(value).not.toHaveProperty("full_output_path")
    expect(value).not.toHaveProperty("wall_time_seconds")
    const bytes = await fixture.nested("bash", { command: "printf '%60000s' tail" })
    const bounded = bytes.structuredOutput as typeof value
    expect(bounded.truncated).toBe(true)
    expect(Buffer.byteLength(bounded.output)).toBeLessThanOrEqual(50 * 1024)
    expect(bounded.output.endsWith("tail")).toBe(true)
    cleanups.push(() => rm(bounded.fullOutputPath, { force: true }))
  })

  it("bounds native read text before creating its structured program value", async () => {
    const fixture = await setup(await nativeCodingTools())
    await writeFile(path.join(fixture.cwd, "large.txt"), "x".repeat(100_000))
    const result = await fixture.nested("read", { path: "large.txt" })
    expect(typeof result.structuredOutput).toBe("string")
    expect(Buffer.byteLength(result.structuredOutput as string)).toBe(50 * 1024)
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "truncated" }))
    expect((await fixture.nested("read", { path: "missing.txt" })).isError).toBe(true)
  })

  it("cancels a running native shell command without its delayed mutation", async () => {
    const fixture = await setup(await nativeCodingTools({ PATH: process.env.PATH }))
    const pending = fixture
      .run("bash", { command: "printf started > started.txt; sleep 2; printf late > late.txt" })
      .catch((error: unknown) => error)
    await vi.waitFor(async () => {
      expect(await readFile(path.join(fixture.cwd, "started.txt"), "utf8")).toBe("started")
    })
    await fixture.root.abort(context)
    expect(await pending).toEqual(
      expect.objectContaining({ message: expect.stringContaining('"aborted"') }),
    )
    await delay(2100)
    await expect(readFile(path.join(fixture.cwd, "late.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    })
  })

  it("preserves native read images and text through codemode with model image limits", async () => {
    const fixture = await setup(await nativeCodingTools())
    fixture.codemode()
    vi.spyOn(fixture.models, "getModel").mockReturnValue({
      ...model,
      inputLimits: { images: { resize: { maxWidth: 2, maxHeight: 2, maxBytes: 1024 } } },
    })
    await fixture.root.configure({ model: { provider: "fixture", modelId: "fixture" } }, context)
    await writeFile(path.join(fixture.cwd, "image.bmp"), bmp(8, 4))
    await writeFile(path.join(fixture.cwd, "text.txt"), "source text")
    const read = await fixture.nested("read", { path: "image.bmp" })
    const image = read.structuredOutput as { type: string; mimeType: string; data: string }
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" })
    const png = Buffer.from(image.data, "base64")
    expect(png.readUInt32BE(16)).toBeLessThanOrEqual(2)
    expect(png.readUInt32BE(20)).toBeLessThanOrEqual(2)
    expect(image.data.length).toBeLessThanOrEqual(1024)
    expect(read.diagnostics).toContainEqual(
      expect.objectContaining({ code: "image", message: expect.stringContaining("Resized") }),
    )
    const result = await fixture.run("codemode", {
      code: 'text(await tools.read({path:"text.txt"})); image(await tools.read({path:"image.bmp"})); text(typeof models);',
    })
    expect(result.message.isError).toBe(false)
    expect(textOf(result.message.content)).toContain("source text")
    expect(textOf(result.message.content)).toContain("undefined")
    expect(result.message.content).toContainEqual(image)
    expect(fixture.reports).toEqual([])
  })

  it("retains native unsupported-model diagnostics and rejects unpreparable images", async () => {
    const fixture = await setup(await nativeCodingTools())
    vi.spyOn(fixture.models, "getModel").mockReturnValue({ ...model, input: ["text"] })
    await fixture.root.configure({ model: { provider: "fixture", modelId: "fixture" } }, context)
    await writeFile(path.join(fixture.cwd, "image.bmp"), bmp(2, 2))
    const read = await fixture.nested("read", { path: "image.bmp" })
    expect(read.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "image",
        message: expect.stringContaining("does not support images"),
      }),
    )
    // Native read keeps the image; pi-ai substitutes the model-facing placeholder.
    expect(read.structuredOutput).toMatchObject({ type: "image" })
    vi.mocked(fixture.models.getModel).mockReturnValue({
      ...model,
      inputLimits: { images: { resize: { maxBytes: 1 } } },
    })
    const rejected = await fixture.nested("read", { path: "image.bmp" })
    expect(rejected.isError).toBe(true)
    expect(rejected.structuredOutput).toBeUndefined()
    expect(rejected.diagnostics).toContainEqual(
      expect.objectContaining({ code: "unsupported_image" }),
    )
  })
})
