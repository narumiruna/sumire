import { getLocale, type MessageKey, t } from "./i18n.js"

export const countNouns = {
  chat: "count.chat",
  tool: "count.tool",
  server: "count.server",
  source: "count.source",
  "server gate": "count.serverGate",
  skill: "count.skill",
  "model setting": "count.modelSetting",
  entry: "count.entry",
  "recorded access decision": "count.decision",
  "save/application record": "count.saveRecord",
  "failed application": "count.failedApplication",
  "total token": "count.totalToken",
  "task record": "count.taskRecord",
  conversation: "count.conversation",
  "published tool name": "count.publishedTool",
  "globally approved published tool name": "count.approvedTool",
  "unsaved change": "count.unsaved",
  "pending policy change": "count.pendingPolicy",
  "chat has": "count.chatHas",
  "default tool name": "count.defaultTool",
  "default MCP server gate": "count.defaultMcp",
  "changed global tool/server name": "count.changedGlobal",
  "changed shared-default tool/server name": "count.changedDefault",
  "tool/server name": "count.toolServer",
  "explicit chat override": "count.override",
  "matching tool": "count.matchingTool",
  "matching server": "count.matchingServer",
  "tool name": "count.toolName",
  "source group": "count.sourceGroup",
} as const satisfies Record<string, MessageKey>

/** English has singular and plural forms; Chinese and Japanese use one count form. */
export function countText(
  count: number,
  singular: keyof typeof countNouns,
  plural = `${singular}s`,
) {
  if (getLocale() === "en") return `${count} ${count === 1 ? singular : plural}`
  return t(countNouns[singular], { count })
}
