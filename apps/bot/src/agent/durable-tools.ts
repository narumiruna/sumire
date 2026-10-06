import type { Context, JsonValue } from "@earendil-works/chord"
import { type JsonObject, type TSchema, validateToolArguments } from "@earendil-works/pi-ai"
import {
  createCodingTools,
  type ExtensionAPI,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable"

export type NativeTool = ToolDefinition<TSchema>

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
    // Reading is replay-safe. Mutations, network requests, and publication are not.
    replay: tool.name === "read" ? "safe" : "unsafe",
    executionMode: "executionMode" in tool ? tool.executionMode : undefined,
    prepareArguments: "prepareArguments" in tool ? tool.prepareArguments : undefined,
    async execute(args, api, context) {
      const result = await executeNative(tool, args, api.callId, context)
      return jsonValue(result) as ToolExecutionResult
    },
  })
}

export async function executeNative(
  tool: NativeTool,
  args: unknown,
  callId: string,
  context: Context,
) {
  context.abortSignal?.throwIfAborted()
  const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args
  const validated = validateToolArguments(tool, {
    type: "toolCall",
    id: callId,
    name: tool.name,
    arguments: jsonValue(prepared) as JsonObject,
  })
  return tool.execute(callId, validated, context.abortSignal, undefined, undefined as never)
}

/** Retain Pi's image-capable coding tools without constructing an AgentSession. */
export function codingTools(cwd: string): NativeTool[] {
  return createCodingTools(cwd).map((tool) => ({
    ...tool,
    label: tool.name,
    execute: (callId, args, signal, onUpdate) => tool.execute(callId, args, signal, onUpdate),
  }))
}
