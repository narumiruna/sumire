import type { Context } from "@earendil-works/chord"
import { withAbortSignal } from "@earendil-works/chord/context"
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript"
import {
  type CodemodeResult,
  type CodemodeRunOptions,
  CodemodeSandbox,
} from "@earendil-works/pi-codemode"
import {
  defineDoc,
  defineExtension,
  GenerationTask,
  type Harness,
  hook,
  section,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable"
import {
  type CodemodeNamespace,
  createCodemodeExtension,
  createCodemodeTool,
} from "@earendil-works/pi-durable/codemode"
import { LegacyCodemodeCallTask } from "./migration.js"

const policyMemo = "sumire.codemode-policy.v1"
export const ToolSelectionDoc = defineDoc({
  checkpointWhen: () => false,
  kind: "sumire.tool-selection",
  version: 1,
  scope: "task",
  initial: () => ({ generations: {} as Record<string, string> }),
})
const generationField = "x-sumire-tool-generation"
type PreparedSchema = ToolRegistration["parameters"] & { [generationField]?: string }

/** Bind to the declarations committed during prepare, not the later live registry. */
export function createToolSelectionExtension(getHarness: () => Harness) {
  return defineExtension({
    name: "sumire-tool-selection",
    hooks: [
      hook(GenerationTask, {
        async beforeRequest(request, api, context) {
          const selected = Object.fromEntries(
            getCurrentTools(request.messages).flatMap((tool) => {
              const generation = (tool.parameters as PreparedSchema)[generationField]
              return typeof generation === "string" ? [[tool.name, generation]] : []
            }),
          )
          // A retry prepares a new request in the same generation task. Replace
          // its selection atomically; replay of the same cutoff restores the same IDs.
          await getHarness().commit(async (tx) => {
            ;(await tx.doc(ToolSelectionDoc, api.taskId)).generations = selected
          }, context)
          // The annotation binds persisted intent only. Do not send it to providers.
          return {
            messages: request.messages.map((message) =>
              message.role === "system" && message.toolsAdded
                ? {
                    ...message,
                    toolsAdded: message.toolsAdded.map((tool) => {
                      const { [generationField]: _generation, ...parameters } =
                        tool.parameters as PreparedSchema
                      return { ...tool, parameters }
                    }),
                  }
                : message,
            ),
          }
        },
      }),
    ],
  })
}
type ScriptPolicy = {
  deadline: number
  generations: Record<string, string>
  aliases: Record<string, string>
}
export type ToolNamespace = CodemodeNamespace & { aliases?: readonly string[] }

/** Only adapt host policy. Pi owns the VM journal and all nested task scheduling. */
class HostDeadlineSandbox extends CodemodeSandbox {
  readonly exits: Promise<void>[]
  succeeded = false
  constructor(private readonly policy: ScriptPolicy) {
    const exits: Promise<void>[] = []
    super({
      memoryLimitBytes: 256 * 1024 * 1024,
      onWorkerStarted: (exited) => {
        exits.push(exited)
      },
    })
    this.exits = exits
  }

  override start(code: string, options: CodemodeRunOptions) {
    const remaining = this.policy.deadline - Date.now()
    if (remaining <= 0) throw new Error("Codemode host deadline passed while interrupted")
    const run = super.start(code, {
      ...options,
      timeoutMs: Math.min(options.timeoutMs ?? remaining, remaining),
      // Preserve MCP namespace aliases without replacing native discovery or its journal.
      onCall: (call) => {
        if (call.target === "global" && Array.isArray(call.args)) {
          const args: unknown[] = [...call.args]
          if (call.name === "describeNamespace" && typeof args[0] === "string")
            args[0] = this.policy.aliases[args[0]] ?? args[0]
          if (call.name === "searchTools" && args[1] && typeof args[1] === "object") {
            const search = args[1] as Record<string, unknown>
            if (typeof search.namespace === "string")
              args[1] = {
                ...search,
                namespace: this.policy.aliases[search.namespace] ?? search.namespace,
              }
          }
          options.onCall({ ...call, args })
        } else options.onCall(call)
      },
    })
    return {
      get finished() {
        return run.finished
      },
      deliver: run.deliver.bind(run),
      result: run.result.then((result): CodemodeResult => {
        if (result.ok && Date.now() >= this.policy.deadline)
          return {
            ok: false,
            error: { kind: "timeout", message: "Codemode host deadline exceeded" },
            output: result.output,
            calls: result.calls,
          }
        this.succeeded = result.ok
        return result
      }),
    }
  }
}

/** Execution guards also run on recovery, where native beforeTool hooks do not run. */
export function guardDurableTool(
  tool: ToolRegistration,
  generation: string,
  generations: () => Record<string, string>,
  authorize: (name: string) => void,
): ToolRegistration {
  return {
    ...tool,
    parameters: { ...tool.parameters, [generationField]: generation },
    async execute(args, api, context) {
      authorize(tool.name)
      if (generations()[tool.name] !== generation)
        throw new Error("Tool selection is stale; discover tools again")
      const policy = await callingPolicy(api, context)
      if (policy && policy.generations[tool.name] !== generation)
        throw new Error("Tool selection is stale; discover tools again")
      if (!policy && tool.name.startsWith("mcp__"))
        throw new Error("Tool selection is stale; discover tools again")
      if (policy?.deadline !== undefined) {
        const remaining = policy.deadline - Date.now()
        if (remaining <= 0) throw new Error("Codemode host deadline passed while interrupted")
        context = withAbortSignal(AbortSignal.timeout(remaining), context)
      }
      context.abortSignal?.throwIfAborted()
      // Recheck after asynchronous policy reads, immediately before the capability runs.
      authorize(tool.name)
      if (generations()[tool.name] !== generation)
        throw new Error("Tool selection is stale; discover tools again")
      return tool.execute(args, api, context)
    },
  }
}

async function callingPolicy(
  api: ToolExecutionApi,
  context: Context,
): Promise<{ generations: Record<string, string>; deadline?: number } | undefined> {
  let task = await api.getTask(api.taskId, context)
  const nested =
    task?.input &&
    typeof task.input === "object" &&
    !Array.isArray(task.input) &&
    task.input.kind === "nested"
  while (task?.owner !== undefined) {
    task = await api.getTask(task.owner, context)
    if (!task || task.state.status === "terminal" || task.state.status === "completing")
      throw new Error("Calling task is no longer active")
    const policy = task.memos?.["sumire.codemode-manifest.v1"] ?? task.memos?.[policyMemo]
    if (policy !== undefined) return policy as ScriptPolicy
    const selected = await api.snapshot(ToolSelectionDoc, task.id, context)
    if (selected !== undefined) return selected
  }
  if (nested) throw new Error("Nested call has no host policy")
  return undefined
}

export function createDurableCodemode(
  timeoutMs: number,
  getHarness: () => Harness,
  generations: () => Record<string, string>,
  namespaces: () => ToolNamespace[],
  ready: (signal?: AbortSignal) => Promise<void>,
  authorize: () => void,
) {
  // No VM is created by construction; every invocation owns and closes its own sandbox.
  const descriptionSandbox = new CodemodeSandbox()
  const native = createCodemodeExtension({ sandbox: descriptionSandbox, models: false })
  const metadata = native.tools?.find((tool) => tool.name === "codemode")
  if (!metadata) throw new Error("Native codemode was not registered")
  return defineExtension({
    name: "sumire-codemode",
    tasks: [LegacyCodemodeCallTask],
    tools: [
      {
        ...metadata,
        executionMode: "sequential",
        async execute(args, api, context) {
          authorize()
          const policy = await api.memo<ScriptPolicy>(
            policyMemo,
            {
              deadline: Date.now() + timeoutMs,
              generations: {},
              aliases: {},
            },
            context,
          )
          const remaining = policy.deadline - Date.now()
          // An expired run may already have a committed native result. Let native
          // return it; only a VM start or new capability execution must refuse.
          if (remaining > 0)
            await ready(
              AbortSignal.any([
                AbortSignal.timeout(remaining),
                ...(context.abortSignal ? [context.abortSignal] : []),
              ]),
            )
          authorize()
          // Discovery can replace the registry during ready(). Resolve a fresh agent once.
          const conversation = await getHarness().conversation(api.conversationId, context)
          if (!conversation) throw new Error("Codemode conversation is missing")
          const agent = await conversation.agent(context)
          // A failed initial MCP connection may have become ready before any VM was admitted.
          const admitted = await api.memo<ScriptPolicy>(
            "sumire.codemode-manifest.v1",
            {
              ...policy,
              generations: generations(),
              aliases: Object.fromEntries(
                namespaces().flatMap((namespace) =>
                  (namespace.aliases ?? []).map((alias) => [alias, namespace.name]),
                ),
              ),
            },
            context,
          )
          const sandbox = new HostDeadlineSandbox(admitted)
          try {
            const tool = createCodemodeTool({ sandbox, models: false, namespaces: namespaces() })
            const result = await tool.execute(
              args as { code: string },
              {
                ...api,
                agent: async () => agent,
                commit: (change, commitContext) =>
                  api.commit(async (tx) => {
                    const checkDeadline = () => {
                      if (sandbox.succeeded && Date.now() >= admitted.deadline)
                        throw new Error("Codemode host deadline exceeded before success commit")
                    }
                    // Formatting can await file writes after the VM finished.
                    // Roll back late success, but allow errors and saved receipts.
                    checkDeadline()
                    const value = await change(tx)
                    checkDeadline()
                    return value
                  }, commitContext),
              },
              context,
            )
            if (result.isError && Date.now() >= policy.deadline)
              return {
                ...result,
                output: [
                  ...(result.output ?? []),
                  {
                    type: "text" as const,
                    text: `Codemode exceeded its ${timeoutMs}ms host deadline.`,
                  },
                ],
              }
            return result
          } finally {
            // Upstream termination unreferences the worker before its exit event.
            // Keep shutdown alive until the VM really exits and SQLite can close.
            const keepAlive = setInterval(() => {}, 1000)
            try {
              await sandbox.close()
              await Promise.all(sandbox.exits)
            } finally {
              clearInterval(keepAlive)
            }
          }
        },
      },
    ],
    sections: [
      section("codemode", (input, context) => {
        const extension = createCodemodeExtension({
          sandbox: descriptionSandbox,
          models: false,
          namespaces: namespaces(),
        })
        return extension.sections?.[0]?.render(input, context)
      }),
      section(
        "codemode_policy",
        () =>
          "Use codemode to batch independent calls, chain tools, or filter results. Never run dependent writes or publication in parallel. update_progress and read_image are model-only. Bash results use exitCode and fullOutputPath. Scripts do not undo completed side effects. Interrupted unsafe tools are not retried automatically.",
      ),
    ],
  })
}
