import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import type { AgentMessage } from "@earendil-works/pi-agent-core"
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"

function assistant(text: string): Extract<AgentMessage, { role: "assistant" }> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  }
}

describe("pinned Pi reply-tree behavior", () => {
  it("creates sibling branches from terminal assistant checkpoints across reload and compaction", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sumire-pi-tree-"))
    const manager = SessionManager.create(root, path.join(root, "sessions"))
    manager.appendMessage({ role: "user", content: "root", timestamp: Date.now() })
    const rootAssistant = manager.appendMessage(assistant("root answer"))
    const session = await createNavigationSession(root, manager)

    manager.appendMessage({ role: "user", content: "later", timestamp: Date.now() })
    manager.appendMessage(assistant("later answer"))
    await session.navigateTree(rootAssistant, { summarize: false })
    const branchAUser = manager.appendMessage({
      role: "user",
      content: "branch A",
      timestamp: Date.now(),
    })
    const branchAAssistant = manager.appendMessage(assistant("branch A answer"))
    await session.navigateTree(rootAssistant, { summarize: false })
    const branchBUser = manager.appendMessage({
      role: "user",
      content: "branch B",
      timestamp: Date.now(),
    })
    manager.appendMessage(assistant("branch B answer"))

    expect(manager.getChildren(rootAssistant).map((entry) => entry.id)).toEqual(
      expect.arrayContaining([branchAUser, branchBUser]),
    )
    session.dispose()

    const sessionFile = manager.getSessionFile()
    expect(sessionFile).toBeDefined()
    const reloadedManager = SessionManager.open(sessionFile ?? "")
    const reloaded = await createNavigationSession(root, reloadedManager)
    await reloaded.navigateTree(branchAAssistant, { summarize: false })
    const context = reloadedManager.buildSessionContext().messages
    expect(JSON.stringify(context)).toContain("branch A answer")
    expect(JSON.stringify(context)).not.toContain("branch B")
    expect(JSON.stringify(context)).not.toContain("later answer")

    reloadedManager.appendCompaction("root and branch A summary", branchAUser, 100)
    reloadedManager.appendMessage({ role: "user", content: "after compact", timestamp: Date.now() })
    const compactedCheckpoint = reloadedManager.appendMessage(assistant("compacted answer"))
    reloadedManager.appendMessage({
      role: "user",
      content: "after checkpoint",
      timestamp: Date.now(),
    })
    reloadedManager.appendMessage(assistant("unrelated later sibling"))
    await reloaded.navigateTree(compactedCheckpoint, { summarize: false })
    reloadedManager.appendMessage({
      role: "user",
      content: "reply after compact",
      timestamp: Date.now(),
    })
    reloadedManager.appendMessage(assistant("reply answer"))

    const compactedContext = reloadedManager.buildSessionContext().messages
    expect(JSON.stringify(compactedContext)).toContain("root and branch A summary")
    expect(JSON.stringify(compactedContext)).toContain("reply after compact")
    expect(JSON.stringify(compactedContext)).not.toContain("unrelated later sibling")
    reloaded.dispose()
  })
})

async function createNavigationSession(cwd: string, sessionManager: SessionManager) {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } })
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: path.join(cwd, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "test",
  })
  await resourceLoader.reload()
  return (
    await createAgentSession({
      cwd,
      noTools: "all",
      resourceLoader,
      sessionManager,
      settingsManager,
    })
  ).session
}
