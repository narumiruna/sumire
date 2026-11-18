import path from "node:path"
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import { Harness } from "@earendil-works/pi-durable"
import type { Issue } from "@narumitw/sumire-issues"
import { expect, it, vi } from "vitest"
import {
  IssueIdentity,
  issueModelRuntime,
  openIssueSession,
  selectIssueModel,
} from "../src/issues/session.js"
import { issueFixtureRuntime } from "./helpers/issue-analysis-runtime.js"
import { report } from "./helpers/issue-report.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

const issue: Issue = {
  id: 1,
  title: "改善操作",
  description: "找不到按鈕 <script>bad</script>",
  source: { section: "Chats", viewport: { width: 1000, height: 800 } },
  section: "Chats",
  state: "open",
  hasScreenshot: false,
  createdAt: 1,
  updatedAt: 1,
  revision: 1,
}
const id = "12345678-1234-4234-8234-123456789abc"
async function fixture() {
  const f = await createPiFixture()
  const policy = f.factory.control.snapshot().policy
  policy.defaults.thinking = "off"
  policy.providers = [{ id: "openai", enabled: true, models: [] }]
  const model = { model: "openai/gpt-6.1-sol", thinking: "off" as const, policy }
  const directory = path.join(f.root, "issue-sessions")
  return { ...f, runtime: issueFixtureRuntime(f), model, directory }
}
it("creates a real empty session without a model call, publishes through a validated tool and dedupes reopen", async () => {
  const f = await fixture()
  const open = vi.spyOn(Harness, "open")
  let session: Awaited<ReturnType<typeof openIssueSession>> | undefined
  try {
    const options = {
      directory: f.directory,
      id,
      runtime: f.runtime,
      guard: () => f.model,
      signal: new AbortController().signal,
    }
    session = await openIssueSession(options)
    expect(session.sessionId).toMatch(/^[a-f0-9-]{36}$/)
    expect(session.conversationId).toBeGreaterThan(0)
    expect(f.requests).toHaveLength(0)
    const identity = await open.mock.results[0]?.value.then(
      (owner: Awaited<ReturnType<typeof Harness.open>>) => owner.snapshot(IssueIdentity, context),
    )
    expect(identity?.id).toBe(session.sessionId)
    f.enqueue("publish_issue_proposals", report, false)
    const submitted = vi.fn()
    expect(
      await session.analyze(issue, "保留現有色彩", f.model, submitted, undefined, [
        "你想保留現有配色嗎？",
      ]),
    ).toEqual(report)
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]?.tools.map((tool) => tool.function.name)).toEqual([
      "publish_issue_proposals",
    ])
    expect(JSON.stringify(f.requests[0]?.messages)).toContain("untrusted data")
    expect(JSON.stringify(f.requests[0]?.messages)).toContain("保留現有色彩")
    expect(JSON.stringify(f.requests[0]?.messages)).toContain("你想保留現有配色嗎？")
    expect(submitted).toHaveBeenCalledWith(expect.any(Number))
    const identityId = session.sessionId
    await session.close()
    session = await openIssueSession(options)
    expect(session.sessionId).toBe(identityId)
    expect(
      await session.analyze(issue, "保留現有色彩", f.model, submitted, undefined, [
        "你想保留現有配色嗎？",
      ]),
    ).toEqual(report)
    expect(f.requests).toHaveLength(1)
  } finally {
    try {
      await session?.close()
    } finally {
      open.mockRestore()
      await f.cleanup()
    }
  }
})
it("rejects prose-only completion rather than treating it as structured proposals", async () => {
  const f = await fixture()
  let session: Awaited<ReturnType<typeof openIssueSession>> | undefined
  try {
    session = await openIssueSession({
      directory: f.directory,
      id,
      runtime: f.runtime,
      guard: () => f.model,
      signal: new AbortController().signal,
    })
    f.enqueueAnswer('Here is JSON: {"summary":"not a tool result"}')
    await expect(session.analyze(issue, "", f.model, () => {})).rejects.toThrow()
  } finally {
    try {
      await session?.close()
    } finally {
      await f.cleanup()
    }
  }
})
it("requires HTTPS for the configured and resolved model endpoints without dispatching a request", async () => {
  const f = await fixture()
  try {
    const { policy } = f.model
    expect(() => selectIssueModel(policy, f.modelRuntime)).toThrow("requires HTTPS")
    const configured = {
      ...policy,
      providers: [
        { id: "openai", enabled: true, models: [], baseUrl: "http://provider.example.test" },
      ],
    }
    expect(() => selectIssueModel(configured, f.runtime)).toThrow("requires HTTPS")
    expect(f.requests).toHaveLength(0)
  } finally {
    await f.cleanup()
  }
})
it("guards replay/model boundaries and exposes no alternate image generation or completion capability", async () => {
  const f = await fixture()
  try {
    expect(selectIssueModel(f.model.policy, f.runtime).ref).toBe(f.model.model)
    const guard = vi.fn(() => {
      throw new Error("revoked")
    })
    const runtime = issueModelRuntime(f.runtime, guard, new AbortController().signal)
    const selected = f.runtime.getModel("openai", "gpt-6.1-sol")
    if (!selected) throw new Error("Missing fixture model")
    expect(() => runtime.streamSimple(selected, { messages: [] })).toThrow("revoked")
    expect(() => runtime.completeSimple(selected, { messages: [] })).toThrow("revoked")
    expect(() => runtime.generateImages({} as never, {} as never)).toThrow("unavailable")
    expect(f.requests).toHaveLength(0)
  } finally {
    await f.cleanup()
  }
})
