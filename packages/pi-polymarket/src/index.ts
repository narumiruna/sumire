import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createPolymarketTools, type PolymarketOptions } from "./client-tools.js"

export type { MethodSpec, PolymarketOptions } from "./client-tools.js"
export { createPolymarketTools, polymarketApi, publicPolymarketToolNames } from "./client-tools.js"

/** Register once per session runtime. The caller owns authentication and permission checks. */
export function registerPolymarketTools(
  pi: ExtensionAPI,
  options: PolymarketOptions = {},
): ReturnType<typeof createPolymarketTools> {
  const runtime = createPolymarketTools(options)
  for (const tool of runtime.tools) pi.registerTool(tool)
  pi.on("session_shutdown", () => runtime.dispose())
  return runtime
}

/** The installable extension exposes public queries only. */
export default function polymarketExtension(pi: ExtensionAPI) {
  registerPolymarketTools(pi)
}
