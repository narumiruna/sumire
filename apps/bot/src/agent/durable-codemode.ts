import type { JsonValue } from "@earendil-works/chord"
import { withoutAbortSignal } from "@earendil-works/chord/context"
import type { AgentToolCallOutcome } from "@earendil-works/pi-agent-core"
import type {
  AgentSessionEvent,
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import {
  defineExtension,
  defineTask,
  defineTool,
  type Harness,
  section,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable"
import { createBotCodemodeExtension } from "./codemode.js"
import { CodemodeStoreDoc } from "./durable-state.js"
import { collectTools, executeNative, jsonValue, type NativeTool } from "./durable-tools.js"

export async function createDurableCodemode(
  nativeTools: NativeTool[],
  timeoutMs: number,
  getHarness: () => Harness,
  emit: (event: AgentSessionEvent) => void,
) {
  const callable = nativeTools.filter(
    (tool) => !("exposure" in tool) || tool.exposure !== "model-only",
  )
  const byName = new Map(callable.map((tool) => [tool.name, tool]))
  type NestedInput = { name: string; args: JsonValue; callId: string; parentCallId: string }
  type NestedPhase = { phase: "call" } | { phase: "interrupted" }
  type NestedResult = {
    content: AgentToolCallOutcome["result"]["content"]
    details?: JsonValue
    structuredContent?: JsonValue
    isError?: boolean
  }
  const failed = (text: string): NestedResult => ({
    content: [{ type: "text", text }],
    isError: true,
  })
  const nestedTask = defineTask<NestedInput, NestedPhase, NestedResult>({
    name: "sumire.codemode-call",
    version: 1,
    initial: () => ({ phase: "call" }),
    phases: {
      async call(task, runtime, context) {
        // Persist a non-replayable intent before executing any nested side effect.
        await runtime.commit(
          () => ({ status: "running", checkpoint: { phase: "interrupted" } }),
          context,
        )
        let result: NestedResult
        const tool = byName.get(task.input.name)
        emit({
          type: "tool_execution_start",
          toolCallId: task.input.callId,
          parentToolCallId: task.input.parentCallId,
          toolName: task.input.name,
          args: task.input.args,
        })
        try {
          if (!tool) throw new Error(`Tool is not callable: ${task.input.name}`)
          result = jsonValue(
            await executeNative(tool, task.input.args, task.input.callId, context),
          ) as NestedResult
        } catch (error) {
          result = failed(error instanceof Error ? error.message : "Nested tool failed")
        }
        emit({
          type: "tool_execution_end",
          toolCallId: task.input.callId,
          parentToolCallId: task.input.parentCallId,
          toolName: task.input.name,
          result,
          isError: result.isError === true,
        })
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result } }),
          context,
        )
      },
      async interrupted(_task, runtime, context) {
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: {
              status: "completed",
              result: failed("Nested tool was interrupted; inspect side effects before retrying."),
            },
          }),
          context,
        )
      },
    },
    async abort(_task, runtime, context) {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context)
    },
  })

  const [metadata] = await collectTools(createBotCodemodeExtension(timeoutMs))
  if (!metadata) throw new Error("Codemode was not registered")
  const loadout = metadata.prepareLoadout?.({
    declared: [metadata, ...nativeTools] as unknown as ExtensionToolContext["tools"],
    callable: callable as unknown as ExtensionToolContext["tools"],
    registered: [metadata, ...nativeTools] as unknown as ExtensionToolContext["tools"],
    getExposure: (name) =>
      name === "codemode"
        ? "model-only"
        : ((nativeTools.find((tool) => tool.name === name) as ToolDefinition | undefined)
            ?.exposure ?? "direct"),
    getNamespace: () => undefined,
  })
  const tool = defineTool({
    name: metadata.name,
    description: loadout?.descriptions?.codemode ?? metadata.description,
    parameters: metadata.parameters,
    constrainedSampling: metadata.constrainedSampling,
    replay: "unsafe",
    executionMode: "sequential",
    async execute(args, api, context) {
      const state = await api.snapshot(CodemodeStoreDoc, api.conversationId, context)
      const writes: Array<{ set: Record<string, JsonValue>; delete: string[] }> = []
      let definition: ToolDefinition | undefined
      await createBotCodemodeExtension(timeoutMs)({
        getSettings: () => ({}),
        getAllTools: () => nativeTools,
        registerTool: (registered: ToolDefinition) => {
          definition = registered
        },
        appendEntry: (
          _type: string,
          data: { set: Record<string, JsonValue>; delete: string[] },
        ) => {
          writes.push(data)
        },
      } as unknown as ExtensionAPI)
      if (!definition) throw new Error("Codemode was not registered")
      let sequence = 0
      const ctx = {
        tools: callable,
        sessionManager: {
          getBranch: () => [
            {
              type: "custom",
              customType: "codemode-store",
              data: { set: state?.values ?? {}, delete: [] },
            },
          ],
        },
        executeTool: async (
          name: string,
          nestedArgs: unknown,
          options: { signal?: AbortSignal } = {},
        ) => {
          const callId = `${api.callId}/${++sequence}`
          const toolCall = {
            type: "toolCall" as const,
            id: callId,
            name,
            arguments: nestedArgs as Record<string, unknown>,
          }
          const taskId = await api.createTask(
            nestedTask,
            { name, args: jsonValue(nestedArgs), callId, parentCallId: api.callId },
            { ownership: { kind: "task", taskId: api.taskId } },
            context,
          )
          const harness = getHarness()
          const signal = options.signal ?? context.abortSignal
          const cancel = () => {
            void harness.abortTask(taskId, withoutAbortSignal(context)).catch(() => {})
          }
          signal?.addEventListener("abort", cancel, { once: true })
          if (signal?.aborted) cancel()
          try {
            const settled = await harness.waitForTask(taskId, withoutAbortSignal(context))
            const outcome = settled.state.outcome
            const result =
              outcome.status === "completed" ? outcome.result : failed("Nested tool was cancelled")
            return {
              toolCall,
              result: { ...result, details: result.details },
              isError: result.isError === true,
            }
          } finally {
            signal?.removeEventListener("abort", cancel)
          }
        },
      } as unknown as ExtensionToolContext
      const result = await definition.execute(api.callId, args, context.abortSignal, undefined, ctx)
      if (!result.isError && writes.length) {
        await api.commit(async (tx) => {
          const store = await tx.doc(CodemodeStoreDoc, api.conversationId)
          for (const change of writes) {
            for (const key of change.delete) delete store.values[key]
            for (const [key, value] of Object.entries(change.set)) store.values[key] = value
          }
        }, context)
      }
      return jsonValue(result) as ToolExecutionResult
    },
  })
  return defineExtension({
    name: "sumire-codemode",
    tools: [tool],
    tasks: [nestedTask],
    sections: [
      section(
        "codemode",
        () =>
          "Use codemode to batch independent tool calls with Promise.allSettled, chain tools, or filter results. Never run dependent writes or publication in parallel. update_progress and read_image are model-only; call them directly. Nested results do not enter the transcript. Scripts do not undo completed side effects.",
      ),
    ],
  })
}
