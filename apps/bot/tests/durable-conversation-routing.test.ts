import path from "node:path"
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context"
import type { JsonObject } from "@earendil-works/pi-ai"
import { createModels } from "@earendil-works/pi-ai/models"
import {
  AgentDoc,
  AssistantEntry,
  type Conversation,
  ConversationBusy,
  type ConversationInit,
  createRegistry,
  defineDoc,
  Harness,
  LiveDoc,
  ProviderDoc,
  ReadAfterWrite,
} from "@earendil-works/pi-durable"
import { CodemodeStoreDoc } from "@earendil-works/pi-durable/codemode"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createPiFixture } from "./helpers/pi-fixture.js"

const fixtures: Awaited<ReturnType<typeof createPiFixture>>[] = []
const harnesses: Harness[] = []

async function setup() {
  // createPiFixture uses helpers/session-factory and a loopback-only provider.
  const fixture = await createPiFixture()
  fixtures.push(fixture)
  const session = await fixture.createSession()
  const main = await session.harness.root(context)
  const agent = {
    model: { provider: session.model.provider, modelId: session.model.id },
    cwd: fixture.settings.botWorkdir,
  }
  return { fixture, session, harness: session.harness, main, agent }
}

async function history(conversation: Conversation) {
  return (await conversation.entries({ order: "ascending" }, 100, undefined, context)).items
}

const PurposeDoc = defineDoc({
  kind: "fixture.routing-purpose",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ purpose: "unset", conversationId: 0 }),
  checkpointWhen: () => false,
})

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close(context)
  for (const fixture of fixtures.splice(0)) await fixture.cleanup()
})

describe("native durable conversation routing contract (1.5.2)", () => {
  it("creates an empty article with explicit agent and atomic document-only init", async () => {
    const { fixture, harness, main, agent } = await setup()
    await main.configure({ instructions: "Main-only instructions" }, context)
    await main.submit(
      {
        type: "write",
        entry: {
          kind: "fixture.main",
          model: [{ role: "user", content: "Main history", timestamp: 0 }],
        },
      },
      context,
    )
    const unconfigured = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      context,
    )
    expect((await unconfigured.agent(context)).model).toBeUndefined()
    expect(await history(unconfigured)).toEqual([])
    const init = vi.fn<ConversationInit>(async (tx, conversationId) => {
      // The second argument is the ID, not a ConversationRecord or handle.
      expect(typeof conversationId).toBe("number")
      expect((await tx.doc(AgentDoc, conversationId)).model).toEqual(agent.model)
      Object.assign(await tx.doc(PurposeDoc, conversationId), {
        purpose: "article",
        conversationId,
      })
      // Creation already wrote a table; document access above is still valid.
      await expect(tx.conversation(conversationId)).rejects.toBeInstanceOf(ReadAfterWrite)
    })
    const article = await harness.createConversation(
      { ownership: { kind: "ownerless" }, agent, init },
      context,
    )
    expect(init).toHaveBeenCalledOnce()
    expect(await harness.snapshot(PurposeDoc, article.id, context)).toEqual({
      purpose: "article",
      conversationId: article.id,
    })
    expect(await history(article)).toEqual([])
    expect((await article.context(context)).messages).toEqual([])
    expect((await harness.snapshot(CodemodeStoreDoc, article.id, context))?.values ?? {}).toEqual(
      {},
    )
    expect((await article.agent(context)).instructions).toBeUndefined()
    expect((await harness.root(context)).id).toBe(main.id)
    const identities = await Promise.all(
      [main, article].map((conversation) =>
        harness.snapshot(ProviderDoc, conversation.id, context),
      ),
    )
    expect(identities[0]?.sessionId).toBeTruthy()
    expect(identities[1]?.sessionId).toBeTruthy()
    expect(identities[0]?.sessionId).not.toBe(identities[1]?.sessionId)

    fixture.enqueueAnswer("Article answer")
    const submission = await article.submit(
      { type: "input", content: "Article source only" },
      context,
    )
    const settled = await submission.wait(context)
    expect(settled).toMatchObject({ status: "done", type: "input" })
    if (settled.status !== "done" || settled.type !== "input") throw new Error("Article unanswered")
    const answer = await article.commit((tx) => tx.entry(AssistantEntry, settled.answer), context)
    expect(answer?.conversationId).toBe(article.id)
    expect(JSON.stringify(fixture.requests[0]?.messages)).toContain("Article source only")
    expect(JSON.stringify(fixture.requests[0]?.messages)).not.toContain("Main history")
    expect(JSON.stringify(fixture.requests[0]?.messages)).not.toContain("Main-only instructions")
    expect(JSON.stringify(await history(main))).not.toContain("Article answer")
  })

  it("runs three conversations independently; cancelling a wait or aborting one does not stop peers", async () => {
    const { fixture, harness, main, agent } = await setup()
    const article = await harness.createConversation(
      { ownership: { kind: "ownerless" }, agent },
      context,
    )
    const reply = await harness.createConversation(
      { ownership: { kind: "ownerless" }, agent },
      context,
    )
    const releaseMain = fixture.pauseNextRequest()
    let releaseArticle = () => {}
    try {
      const mainSubmission = await main.submit({ type: "input", content: "Blocked main" }, context)
      await vi.waitFor(() => expect(fixture.requests).toHaveLength(1))
      await expect(
        main.submit({ type: "input", content: "Rejected main", whenBusy: "reject" }, context),
      ).rejects.toBeInstanceOf(ConversationBusy)
      const queued = await main.submit(
        { type: "input", content: "Queued main, not steering" },
        context,
      )
      expect(await queued.status(context)).toMatchObject({ status: "queued" })
      expect(await queued.abort(context)).toBe("aborted")
      expect(await queued.wait(context)).toMatchObject({ status: "unanswered" })
      expect(fixture.requests).toHaveLength(1)
      releaseArticle = fixture.pauseNextRequest()
      const articleSubmission = await article.submit(
        { type: "input", content: "Blocked article" },
        context,
      )
      await vi.waitFor(() => expect(fixture.requests).toHaveLength(2))
      const cancellation = new AbortController()
      const reason = new Error("Only the caller stopped waiting")
      const cancelledWait = articleSubmission.wait(withAbortSignal(cancellation.signal, context))
      const rejected = expect(cancelledWait).rejects.toBe(reason)
      cancellation.abort(reason)
      await rejected

      fixture.enqueueAnswer("Independent reply answer")
      const replySubmission = await reply.submit(
        { type: "input", content: "Reply question" },
        context,
      )
      const replySettled = await replySubmission.wait(context)
      await reply.waitForIdle(context)
      expect(fixture.requests).toHaveLength(3)
      expect(replySettled).toMatchObject({ status: "done", type: "input" })
      const mainRun = (await harness.snapshot(LiveDoc, main.id, context))?.run
      const articleRun = (await harness.snapshot(LiveDoc, article.id, context))?.run
      expect(mainRun).toBeDefined()
      expect(articleRun).toBeDefined()
      expect(mainRun?.taskId).not.toBe(articleRun?.taskId)
      expect(JSON.stringify(fixture.requests[2]?.messages)).not.toMatch(
        /Blocked main|Blocked article/,
      )

      await article.abort(context)
      await vi.waitFor(() => expect(fixture.disconnectedRequests).toBe(1))
      expect(await articleSubmission.wait(context)).toMatchObject({
        status: "unanswered",
        reason: "aborted",
      })
      expect((await harness.snapshot(LiveDoc, main.id, context))?.run?.taskId).toBe(mainRun?.taskId)
      expect(await replySubmission.wait(context)).toEqual(replySettled)
      fixture.enqueueAnswer("Main answer after reply")
      releaseMain()
      expect(await mainSubmission.wait(context)).toMatchObject({ status: "done", type: "input" })
      expect(JSON.stringify(await history(main))).toContain("Main answer after reply")
      expect(JSON.stringify(await history(main))).not.toContain("Independent reply answer")
      expect(JSON.stringify(await history(reply))).not.toContain("Main answer after reply")
    } finally {
      await Promise.all([main.abort(context), article.abort(context), reply.abort(context)])
      releaseArticle()
      releaseMain()
    }
  })

  it("forks a busy main at a historical checkpoint with codemode snapshot and nested ancestry", async () => {
    const { fixture, session, harness, main } = await setup()
    await main.configure({ instructions: "Checkpoint instructions" }, context)
    await fixture.script(session, 'store("topic", { version: 1 }); console.log("Checkpoint one");')
    const checkpoint = (await history(main)).at(-1)
    if (!checkpoint) throw new Error("Missing fixture checkpoint")
    const checkpointHistory = await history(main)
    await main.configure({ instructions: "Later main instructions" }, context)
    await fixture.script(
      session,
      'store("topic", { version: 2 }); console.log("Later main context");',
    )
    expect((await harness.snapshot(CodemodeStoreDoc, main.id, context))?.values).toEqual({
      topic: { version: 2 },
    })
    const release = fixture.pauseNextRequest()
    try {
      const requestCount = fixture.requests.length
      const pending = await main.submit({ type: "input", content: "Busy main tail" }, context)
      await vi.waitFor(() => expect(fixture.requests).toHaveLength(requestCount + 1))
      const running = (await harness.snapshot(LiveDoc, main.id, context))?.run?.taskId
      expect(running).toBeDefined()
      const branch = await main.fork(checkpoint.id, { ownership: { kind: "ownerless" } }, context)
      const sibling = await main.fork(checkpoint.id, { ownership: { kind: "ownerless" } }, context)
      expect(branch.id).not.toBe(sibling.id)
      for (const conversation of [branch, sibling]) {
        expect(await history(conversation)).toEqual(checkpointHistory)
        expect((await conversation.agent(context)).instructions).toBe("Checkpoint instructions")
        expect(
          (await harness.snapshot(CodemodeStoreDoc, conversation.id, context))?.values,
        ).toEqual({
          topic: { version: 1 },
        })
        expect((await harness.snapshot(LiveDoc, conversation.id, context))?.run).toBeUndefined()
        expect(
          await harness.commit((tx) => tx.conversation(conversation.id), context),
        ).toMatchObject({
          parent: { conversationId: main.id, at: checkpoint.id },
        })
      }
      const branchEntry = await branch.commit(async (tx) => {
        ;(await tx.doc(CodemodeStoreDoc, branch.id)).values.topic = { version: 3 }
        return tx.appendEntry(branch.id, { kind: "fixture.branch", data: "Branch-only history" })
      }, context)
      const nested = await branch.fork(
        branchEntry.id,
        { ownership: { kind: "ownerless" } },
        context,
      )
      expect(await harness.commit((tx) => tx.conversation(nested.id), context)).toMatchObject({
        parent: { conversationId: branch.id, at: branchEntry.id },
      })
      expect(await history(nested)).toEqual([...checkpointHistory, branchEntry])
      expect((await harness.snapshot(CodemodeStoreDoc, nested.id, context))?.values.topic).toEqual({
        version: 3,
      })
      expect((await harness.snapshot(CodemodeStoreDoc, sibling.id, context))?.values.topic).toEqual(
        { version: 1 },
      )
      expect((await harness.snapshot(CodemodeStoreDoc, main.id, context))?.values.topic).toEqual({
        version: 2,
      })
      expect((await harness.snapshot(LiveDoc, main.id, context))?.run?.taskId).toBe(running)
      expect((await harness.root(context)).id).toBe(main.id)
      await main.abort(context)
      expect(await pending.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" })
      await vi.waitFor(() => expect(fixture.disconnectedRequests).toBe(1))
    } finally {
      await main.abort(context)
      release()
    }
  })

  it("migrates an isolated legacy active pointer to stable main before scheduling and persists the upgrade", async () => {
    const { fixture } = await setup()
    // These fixture definitions do not import or register the app's session state.
    const semantics = { scope: "session", history: "latest", checkpointWhen: () => false } as const
    const legacy = defineDoc({
      ...semantics,
      kind: "fixture.routing-session",
      version: 1,
      initial: () => ({
        sessionId: "fixture-chat",
        activeConversation: 0,
        pending: [] as string[],
      }),
    })
    const migrate = vi.fn((value: JsonObject, fromVersion: number) => {
      if (
        fromVersion !== 1 ||
        typeof value.sessionId !== "string" ||
        typeof value.activeConversation !== "number" ||
        !Array.isArray(value.pending) ||
        !value.pending.every((id: unknown) => typeof id === "string")
      )
        throw new Error("Invalid legacy routing fixture")
      return {
        sessionId: value.sessionId,
        mainConversation: value.activeConversation,
        pending: value.pending as string[],
      }
    })
    const current = defineDoc({
      ...semantics,
      kind: "fixture.routing-session",
      version: 2,
      initial: () => ({ sessionId: "fixture-chat", mainConversation: 0, pending: [] as string[] }),
      migrate,
    })
    const file = path.join(fixture.root, "routing-upgrade.sqlite")
    const open = async () => {
      // No provider is installed: reopening/migrating must not need a model.
      const harness = await Harness.open(
        await openNodeSqliteStorage(file),
        {
          models: createModels(),
          registry: createRegistry(),
        },
        context,
      )
      harnesses.push(harness)
      return harness
    }
    const old = await open()
    const root = await old.root(context)
    const entry = await root.commit(
      (tx) => tx.appendEntry(root.id, { kind: "fixture.old", data: "Preserved history" }),
      context,
    )
    const selectedFork = await root.fork(entry.id, { ownership: { kind: "ownerless" } }, context)
    await old.commit(async (tx) => {
      Object.assign(await tx.doc(legacy), {
        activeConversation: selectedFork.id,
        pending: ["pending-request"],
      })
    }, context)
    await old.close(context)
    const upgraded = await open()
    await upgraded.commit(async (tx) => {
      await tx.doc(current)
    }, context)
    const expected = {
      sessionId: "fixture-chat",
      mainConversation: selectedFork.id,
      pending: ["pending-request"],
    }
    expect(await upgraded.snapshot(current, context)).toEqual(expected)
    expect(migrate).toHaveBeenCalledOnce()
    expect(migrate.mock.calls[0]?.[1]).toBe(1)
    const restored = await upgraded.conversation(selectedFork.id, context)
    if (!restored) throw new Error("Missing preserved legacy conversation")
    expect(await history(restored)).toEqual([entry])
    await upgraded.close(context)
    const reopened = await open()
    expect(await reopened.snapshot(current, context)).toEqual(expected)
    expect(migrate).toHaveBeenCalledOnce()
    expect(await reopened.commit((tx) => tx.conversation(selectedFork.id), context)).toMatchObject({
      parent: { conversationId: root.id, at: entry.id },
    })
    expect(fixture.requests).toHaveLength(0)
  })
})
