import type { BuildSystemPromptOptions } from "@earendil-works/pi-coding-agent"

// Pi 1.3.0 ships this builder but does not export it from the package root.
// Reuse it without creating an AgentSession or copying Pi's default instructions.
const { buildSystemPrompt } = (await import(
  new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href
)) as { buildSystemPrompt: (options: BuildSystemPromptOptions) => string }

export { buildSystemPrompt as buildPiSystemPrompt }
