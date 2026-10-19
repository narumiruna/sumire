import type { JsonValue } from "@earendil-works/chord"
import { type TSchema, Type } from "@earendil-works/pi-ai"
import type {
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable"
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node"
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools"

export type NativeTool = ToolDefinition<TSchema>

export function isCodemodeCallable(tool: Pick<NativeTool, "exposure">): boolean {
  return tool.exposure !== "model-only" && tool.exposure !== "hidden"
}

/** Discard optional undefined fields before values cross durable's JSON-only storage boundary. */
export function jsonValue<T>(value: T): T & JsonValue {
  return JSON.parse(JSON.stringify(value))
}

export async function collectTools(factory: ExtensionFactory): Promise<ToolDefinition[]> {
  const tools: ToolDefinition[] = []
  await factory({
    getSettings: () => ({}),
    getAllTools: () => [],
    registerTool: (tool: ToolDefinition) => {
      tools.push(tool)
    },
  } as unknown as ExtensionAPI)
  return tools
}

export function adaptTool(tool: NativeTool) {
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    constrainedSampling: tool.constrainedSampling,
    structuredOutputSchema: tool.outputSchema,
    callers:
      tool.exposure === "hidden"
        ? []
        : tool.exposure === "model-only"
          ? ["model"]
          : tool.exposure === "codemode"
            ? ["tools"]
            : undefined,
    deferred: tool.exposure === "deferred" ? true : undefined,
    // External capabilities are unsafe unless repeating their effects is proven safe.
    replay: "unsafe",
    executionMode: tool.executionMode,
    prepareArguments: tool.prepareArguments,
    async execute(args, api, context) {
      context.abortSignal?.throwIfAborted()
      // Harness prepares and validates arguments for both direct and nested calls.
      const result = await tool.execute(
        api.callId,
        args,
        context.abortSignal,
        undefined,
        undefined as never,
      )
      return durableToolResult(result)
    },
  })
}

/** Keep model output, program data, and UI details on separate durable channels. */
export function durableToolResult(
  result: Awaited<ReturnType<NativeTool["execute"]>>,
): ToolExecutionResult {
  return jsonValue({
    output: result.content,
    structuredOutput:
      result.structuredContent === undefined ? undefined : jsonValue(result.structuredContent),
    details: result.details === undefined ? undefined : jsonValue(result.details),
    isError: result.isError,
    usage: result.usage,
    control: result.terminate ? { terminate: true } : undefined,
  })
}

/** Native tools use the call's Harness environment; the host owns its lifecycle. */
export async function nativeCodingTools(
  shellEnvironment: NodeJS.ProcessEnv = {},
): Promise<ToolRegistration[]> {
  const read = createReadTool({ images: await createNodePhotonImages({ worker: false }) })
  const shellEnv = Object.fromEntries(
    Object.entries(shellEnvironment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  return [
    defineTool({
      ...read,
      replay: "safe",
      // Native codemode drops images from schema-less results. Keep read's bounded
      // text or prepared image as its program value, without changing model output.
      structuredOutputSchema: Type.Union([
        Type.String(),
        Type.Object({
          type: Type.Literal("image"),
          data: Type.String(),
          mimeType: Type.String(),
        }),
      ]),
      async execute(args, api, context) {
        const result = await read.execute(args, api, context)
        if (result.isError) return result
        const block = result.output?.[0]
        return {
          ...result,
          structuredOutput: block?.type === "image" ? jsonValue(block) : (block?.text ?? ""),
        }
      },
    }),
    {
      ...createBashTool({
        prepare(execution) {
          // NodeExecutionEnv.shellEnv alone still inherits process.env.
          execution.inheritEnv = false
          execution.env = { ...shellEnv }
        },
      }),
      replay: "unsafe",
    },
    { ...createEditTool(), replay: "unsafe" },
    { ...createWriteTool(), replay: "unsafe" },
  ]
}
