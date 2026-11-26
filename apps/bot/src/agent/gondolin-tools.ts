import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import type { VM } from "@earendil-works/gondolin"
import {
  createEditToolDefinition,
  createWriteToolDefinition,
  type EditToolInput,
  truncateHead,
  type WriteToolInput,
} from "@earendil-works/pi-coding-agent"
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable"
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node"
import {
  createBashTool,
  createReadTool,
  DEFAULT_IMAGE_LIMITS,
} from "@earendil-works/pi-durable/tools"
import { adaptTool, type NativeTool } from "./durable/tools.js"
import {
  boundedFile,
  type GondolinSandbox,
  guestPath,
  guestWorkdir,
  imageType,
} from "./gondolin.js"

/** Bounded selection, including for a file with a multi-gigabyte single line. */
async function textRange(
  vm: VM,
  file: string,
  offset: number,
  limit: number | undefined,
  signal: AbortSignal,
) {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 1 ||
    (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
  )
    throw new Error("offset must be a positive integer and limit a nonnegative integer")
  if (limit === 0) return { content: "", truncated: false }
  const decoder = new TextDecoder()
  let line = 1
  let selected = ""
  let selectedBytes = 0
  let capped = false
  let done = false
  const end = offset + (limit ?? Number.POSITIVE_INFINITY)
  const consume = (text: string) => {
    const pieces = text.split("\n")
    for (let index = 0; index < pieces.length; index++) {
      const piece = pieces[index] ?? ""
      if (line >= offset && line < end) {
        if (line - offset >= 2_000) {
          capped = true
          return
        }
        selected += piece
        selectedBytes += Buffer.byteLength(piece)
        if (selectedBytes > 50 * 1024) {
          capped = true
          return
        }
        if (index < pieces.length - 1 && line + 1 < end) {
          selected += "\n"
          selectedBytes++
        }
      }
      if (index < pieces.length - 1) line++
      if (line >= end) {
        done = true
        return
      }
    }
  }
  const stream = await vm.fs.readFileStream(guestPath(file), { signal, chunkSize: 64 * 1024 })
  try {
    for await (const chunk of stream) {
      signal.throwIfAborted()
      consume(decoder.decode(chunk, { stream: true }))
      if (done || capped) break
    }
    if (!done && !capped) consume(decoder.decode())
  } finally {
    stream.destroy()
  }
  signal.throwIfAborted()
  if (line < offset) throw new Error(`Offset ${offset} is beyond end of file`)
  const bounded = truncateHead(selected)
  if (bounded.firstLineExceedsLimit)
    throw new Error("Selected line exceeds 50KB; use bash for a bounded byte range")
  return { content: bounded.content, truncated: capped || bounded.truncated }
}

/** Preserve Pi schemas and edit semantics without giving the Harness a host ExecutionEnv. */
export async function gondolinCodingTools(sandbox: GondolinSandbox): Promise<ToolRegistration[]> {
  const images = await createNodePhotonImages({ worker: false })
  const read = defineTool({
    ...createReadTool({ images }),
    replay: "safe",
    async execute(args, api, context) {
      return sandbox.run("read", context.abortSignal, 300, async (vm, signal) => {
        const mimeType = await imageType(vm, args.path, signal)
        if (mimeType) {
          const ref = (await api.agent(context)).model
          const model = ref && api.models.getModel(ref.provider, ref.modelId)
          const resize = model?.inputLimits?.images?.resize
          const prepared = await images.prepare(
            await boundedFile(vm, args.path, signal),
            mimeType,
            {
              maxWidth: resize?.maxWidth ?? DEFAULT_IMAGE_LIMITS.maxWidth,
              maxHeight: resize?.maxHeight ?? DEFAULT_IMAGE_LIMITS.maxHeight,
              maxBytes: resize?.maxBytes ?? DEFAULT_IMAGE_LIMITS.maxBytes,
            },
          )
          signal.throwIfAborted()
          if (!prepared) throw new Error("Image cannot be prepared within model limits")
          const block = { type: "image" as const, data: prepared.data, mimeType: prepared.mimeType }
          return { output: [block], structuredOutput: block }
        }
        const text = await textRange(vm, args.path, args.offset ?? 1, args.limit, signal)
        if (text.truncated)
          api.diagnostic({
            severity: "info",
            code: "truncated",
            message: "Read limited to 2000 lines or 50KB. Continue with offset/limit.",
          })
        return {
          output: [{ type: "text" as const, text: text.content }],
          structuredOutput: text.content,
        }
      })
    },
  })
  const files = [
    createWriteToolDefinition(guestWorkdir),
    createEditToolDefinition(guestWorkdir),
  ].map((definition) => {
    const native: NativeTool = {
      name: definition.name,
      label: definition.label,
      description: definition.description,
      parameters: definition.parameters,
      constrainedSampling: definition.constrainedSampling,
      prepareArguments: definition.prepareArguments,
      execute: (id, args, signal, update, context) =>
        sandbox.run(definition.name, signal, 300, async (vm, scopedSignal) => {
          const writeFile = (file: string, content: string) =>
            vm.fs.writeFile(guestPath(file), content, { signal: scopedSignal })
          if (definition.name === "write") {
            const tool = createWriteToolDefinition(guestWorkdir, {
              operations: {
                writeFile,
                mkdir: (dir) =>
                  vm.fs.mkdir(guestPath(dir), { recursive: true, signal: scopedSignal }),
              },
            })
            const input = args as WriteToolInput
            return tool.execute(
              id,
              { ...input, path: guestPath(input.path) },
              scopedSignal,
              update,
              context,
            )
          }
          const tool = createEditToolDefinition(guestWorkdir, {
            operations: {
              writeFile,
              readFile: (file) => boundedFile(vm, file, scopedSignal),
              access: (file) =>
                vm.fs.access(guestPath(file), {
                  mode: constants.R_OK | constants.W_OK,
                  signal: scopedSignal,
                }),
            },
          })
          const input = args as EditToolInput
          return tool.execute(
            id,
            { ...input, path: guestPath(input.path) },
            scopedSignal,
            update,
            context,
          )
        }),
    }
    return adaptTool(native)
  })
  const bash = defineTool({
    ...createBashTool(),
    description:
      "Execute bash inside a disposable Gondolin VM. Only /workspace persists. Combined output is limited to the last 2000 lines or 50KB; full output is saved under /workspace/.sumire-output. Default timeout: 300 seconds; maximum: 3600 seconds.",
    replay: "unsafe",
    async execute(args, api, context) {
      return sandbox.run("bash", context.abortSignal, args.timeout ?? 300, async (vm, signal) => {
        const directory = `${guestWorkdir}/.sumire-output`
        await vm.fs.mkdir(directory, { recursive: true, signal })
        const outputPath = `${directory}/${randomUUID()}.txt`
        // No host temp file. User code is an argument to its own shell, not
        // interpolated into the trusted tee/exit-code wrapper.
        const proc = vm.exec(
          [
            "/bin/bash",
            "-c",
            `set -o pipefail; /bin/bash -lc "$1" 2>&1 | tee -- "$2"; exit "\${PIPESTATUS[0]}"`,
            "sumire",
            args.command,
            outputPath,
          ],
          { cwd: guestWorkdir, signal, stdout: "pipe", stderr: "pipe" },
        )
        const result = Promise.resolve(proc)
        result.catch(() => {})
        for await (const chunk of proc.output()) api.output(chunk.text)
        const { exitCode } = await result
        signal.throwIfAborted()
        const retained = api.retainedOutput()
        const fullOutputPath = retained.truncated ? outputPath : undefined
        if (fullOutputPath)
          api.diagnostic({
            severity: "info",
            code: "full_output",
            message: `Full output: ${fullOutputPath}`,
          })
        else await vm.fs.deleteFile(outputPath, { force: true, signal })
        return {
          structuredOutput: {
            output: retained.text,
            truncated: retained.truncated,
            exitCode,
            ...(fullOutputPath ? { fullOutputPath } : {}),
          },
          ...(exitCode === 0
            ? {}
            : {
                isError: true,
                diagnostics: [
                  {
                    severity: "error" as const,
                    code: "exit_code",
                    message: `Command exited with code ${exitCode}`,
                  },
                ],
              }),
        }
      })
    },
  })
  return [read, bash, ...files]
}
