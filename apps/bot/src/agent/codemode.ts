import { createCodemodeExtension, type ExtensionFactory } from "@earendil-works/pi-coding-agent"

/** Keep Pi's tool contract and sandbox; add only a host-owned execution deadline. */
export function createBotCodemodeExtension(timeoutMs: number): ExtensionFactory {
  const nativeExtension = createCodemodeExtension({ mode: "on", models: false })
  return (pi) =>
    nativeExtension({
      ...pi,
      registerTool(tool) {
        pi.registerTool({
          ...tool,
          async execute(toolCallId, params, signal, onUpdate, ctx) {
            signal?.throwIfAborted()
            const deadline = new AbortController()
            const timeoutError = new Error(`Codemode exceeded its ${timeoutMs}ms host deadline.`)
            const timer = setTimeout(() => deadline.abort(timeoutError), timeoutMs)
            timer.unref()
            const executionSignal = signal
              ? AbortSignal.any([signal, deadline.signal])
              : deadline.signal
            try {
              const result = await tool.execute(toolCallId, params, executionSignal, onUpdate, ctx)
              return executionSignal.reason === timeoutError
                ? {
                    ...result,
                    isError: true,
                    content: [...result.content, { type: "text", text: timeoutError.message }],
                  }
                : result
            } finally {
              clearTimeout(timer)
            }
          },
        })
      },
    })
}
