import type { AgentSession } from "@earendil-works/pi-coding-agent"

export interface SessionModelSettings {
  readonly model: AgentSession["model"]
  readonly thinkingLevel: AgentSession["thinkingLevel"]
  readonly modelRuntime: Pick<AgentSession["modelRuntime"], "getAvailable">
  setModel: AgentSession["setModel"]
  setThinkingLevel: AgentSession["setThinkingLevel"]
  getAvailableThinkingLevels: AgentSession["getAvailableThinkingLevels"]
}

export interface ChatModelState {
  currentModel: string | undefined
  thinkingLevel: AgentSession["thinkingLevel"]
  thinkingLevels: ReturnType<AgentSession["getAvailableThinkingLevels"]>
}

export interface ChatModelSettings extends ChatModelState {
  models: string[]
}

export class ModelSettingsError extends Error {}

export function currentModelState(session: SessionModelSettings): ChatModelState {
  return {
    currentModel: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
    thinkingLevel: session.thinkingLevel,
    thinkingLevels: session.getAvailableThinkingLevels(),
  }
}
