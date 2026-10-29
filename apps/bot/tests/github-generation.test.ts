import path from "node:path"
import { Harness } from "@earendil-works/pi-durable"
import type { GithubMention } from "@narumitw/sumire-github-notifications"
import { expect, it, vi } from "vitest"
import {
  createGithubReplyGenerator,
  githubModelRuntime,
  githubModelSelection,
} from "../src/github/generation.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

const mention: GithubMention = {
  key: "42:issue:1:v1",
  account: { id: 42, login: "sumire-bot" },
  author: "trusted-author",
  repository: "owner/repo",
  issueNumber: 1,
  title: "Untrusted title",
  body: "@sumire-bot Explain the supplied example.",
  url: "https://github.com/owner/repo/issues/1",
  source: { kind: "issue", id: 1, updatedAt: "2030-01-01T12:00:00Z" },
  threadId: "1",
}

async function fixture() {
  const f = await createPiFixture()
  const policy = f.factory.control.snapshot().policy
  policy.defaults.thinking = "off"
  policy.providers = [{ id: "openai", enabled: true, models: [] }]
  const generate = createGithubReplyGenerator({
    directory: path.join(f.root, ".telegramagent", "github"),
    settings: f.settings,
    runtime: f.modelRuntime,
    policy: () => policy,
  })
  return { ...f, policy, generate }
}

it("generates through real Harness submit/wait, with no tools and isolated durable dedupe", async () => {
  const f = await fixture()
  const open = vi.spyOn(Harness, "open")
  const authorize = vi.fn()
  try {
    f.enqueueAnswer("A plain **Markdown** reply.")
    const answer = await f.generate(mention, authorize, new AbortController().signal)
    expect(answer).toEqual({ text: "A plain **Markdown** reply.", model: "openai/gpt-6.1-sol" })
    expect(open).toHaveBeenCalled()
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]?.tools ?? []).toEqual([])
    const messages = f.requests[0]?.messages ?? []
    expect(JSON.stringify(messages)).toContain("You are Sumire")
    expect(JSON.stringify(messages)).toContain("untrusted user data")
    expect(JSON.stringify(messages)).toContain("Untrusted title")
    expect(JSON.stringify(messages)).not.toContain("Telegram")
    expect(authorize).toHaveBeenCalled()
    // Reopen the same durable conversation without starting a second model turn.
    expect(await f.generate(mention, authorize, new AbortController().signal)).toEqual(answer)
    expect(f.requests).toHaveLength(1)
    const session = await f.createSession()
    expect(session.getActiveToolNames()).not.toContain("read_github_notifications")
    expect(session.nativeTools.map((tool) => tool.name)).not.toContain("read_github_notifications")
  } finally {
    open.mockRestore()
    await f.cleanup()
  }
})

it("interrupts a Harness request on shutdown and enforces current policy before resuming", async () => {
  const f = await fixture()
  const controller = new AbortController()
  const release = f.pauseNextRequest()
  try {
    f.enqueueAnswer("Recovered without changing the reply intent.")
    const running = f.generate(mention, () => {}, controller.signal)
    const stopped = expect(running).rejects.toThrow()
    await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    controller.abort()
    await stopped
    release()
    await vi.waitFor(() => expect(f.pendingReplies).toBe(0))
    f.enqueueAnswer("Recovered without changing the reply intent.")
    const provider = f.policy.providers[0]
    if (!provider) throw new Error("Missing fixture provider")
    provider.enabled = false
    await expect(f.generate(mention, () => {}, new AbortController().signal)).rejects.toThrow(
      "not enabled",
    )
    expect(f.requests).toHaveLength(1)
    provider.enabled = true
    expect(await f.generate(mention, () => {}, new AbortController().signal)).toEqual({
      text: "Recovered without changing the reply intent.",
      model: "openai/gpt-6.1-sol",
    })
    expect(f.requests).toHaveLength(2)
  } finally {
    release()
    await f.cleanup()
  }
})

it("guards every model request and denies non-chat operations at the runtime boundary", async () => {
  const f = await fixture()
  try {
    const authorize = vi.fn()
    const runtime = githubModelRuntime(
      f.modelRuntime,
      () => f.policy,
      authorize,
      new AbortController().signal,
    )
    const selected = githubModelSelection(f.policy, f.modelRuntime)
    f.policy.defaults.models = []
    expect(() => runtime.streamSimple(selected.model, { messages: [] })).toThrow(
      "allowed shared default",
    )
    expect(authorize).toHaveBeenCalledTimes(1)
    f.policy.defaults.models = [...f.policy.models]
    expect(() =>
      runtime.streamSimple(selected.model, { messages: [] }, { reasoning: "high" }),
    ).toThrow("settings changed")
    authorize.mockImplementationOnce(() => {
      throw new Error("revoked")
    })
    expect(() => runtime.streamSimple(selected.model, { messages: [] })).toThrow("revoked")
    expect(() => runtime.generateImages(undefined as never, undefined as never)).toThrow(
      "not available",
    )
    expect(() => runtime.classify(undefined as never, undefined as never)).toThrow("not available")
    expect(f.requests).toHaveLength(0)
  } finally {
    await f.cleanup()
  }
})
