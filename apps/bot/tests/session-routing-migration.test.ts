import assert from "node:assert/strict"
import { copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai/models"
import {
  createRegistry,
  defineDoc,
  Harness,
  type JsonObject,
  type Storage,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createDurableInspector,
  parseDurableInspectionQuery,
} from "../src/admin/durable-inspector.js"
import {
  BotSessionDoc,
  ConversationPurposeDoc,
  OutboxDoc,
  validateBotSessionState,
} from "../src/agent/durable/state.js"

const identity = { sessionId: "fixture-session", trustKey: "fixture-trust" }
const LegacySessionDoc = defineDoc<JsonObject>({
  checkpointWhen: () => false,
  kind: "sumire.session",
  version: 1,
  scope: "session",
  initial: () => ({ ...identity, activeConversation: 1 }),
})
const harnesses = new Set<Harness>()
const directories: string[] = []

afterEach(async () => {
  for (const harness of harnesses) await harness.close(context)
  harnesses.clear()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "sumire-session-routing-migration-"))
  directories.push(directory)
  const file = path.join(directory, "chat.sqlite")
  const env = vi.fn(() => {
    throw new Error("Migration must not execute model or tool work")
  })
  const open = async (database = file) => {
    const storage = await openNodeSqliteStorage(database)
    const harness = await Harness.open(
      storage,
      { models: createModels(), registry: createRegistry(), env },
      context,
    )
    harnesses.add(harness)
    return { harness, storage }
  }
  return { directory, file, open, env }
}

async function close(harness: Harness) {
  await harness.close(context)
  harnesses.delete(harness)
}

async function sessionDocument(storage: Storage) {
  const record = await storage.findDocument(
    { kind: "sumire.session", scope: { kind: "session" } },
    "current",
    context,
  )
  assert(record)
  const stored = await storage.document(record.id, "current", context)
  assert(stored)
  return stored
}

async function upgrade(harness: Harness) {
  expect((await harness.inspect(context)).scheduling).toBe("paused")
  const root = await harness.root(context)
  return root.commit(async (tx) => {
    const state = await tx.doc(BotSessionDoc)
    validateBotSessionState(state)
    return { ...state }
  }, context)
}

async function legacyFixture() {
  const f = await fixture()
  const { harness, storage } = await f.open()
  const root = await harness.root(context)
  const checkpoint = await root.commit(
    (tx) => tx.appendEntry(root.id, { kind: "fixture.checkpoint", data: { retained: true } }),
    context,
  )
  const branch = await root.fork(checkpoint.id, { ownership: { kind: "ownerless" } }, context)
  const input = await branch.commit(
    (tx) => tx.appendEntry(branch.id, { kind: "fixture.input", data: "retained input" }),
    context,
  )
  const selected = await branch.fork(input.id, { ownership: { kind: "ownerless" } }, context)
  const submission = await selected.commit(async (tx) => {
    const state = await tx.doc(LegacySessionDoc)
    state.activeConversation = selected.id
    const submission = await tx.createSubmission({
      conversationId: selected.id,
      requestId: "pending-request",
      type: "input",
      status: "queued",
    })
    const outbox = await tx.doc(OutboxDoc)
    outbox.pending.push({
      requestId: "pending-request",
      conversationId: selected.id,
      content: "pending input",
      delivery: { sourceMessageId: 101, statusMessageId: 102, mode: "publish" },
      textMessageIds: [103],
    })
    outbox.mediaReceipts.push({ requestId: "pending-request", id: "media", messageId: 104 })
    return submission
  }, context)
  const before = {
    session: await sessionDocument(storage),
    conversations: await storage.scanConversations({}, 100, undefined, context),
    entries: await selected.entries({ order: "ascending" }, 100, undefined, context),
    outbox: await harness.snapshot(OutboxDoc, context),
    submission,
  }
  await close(harness)
  return { ...f, root, branch, selected, before }
}

async function expectPreserved(
  storage: Storage,
  harness: Harness,
  f: Awaited<ReturnType<typeof legacyFixture>>,
) {
  expect(await storage.scanConversations({}, 100, undefined, context)).toEqual(
    f.before.conversations,
  )
  const selected = await harness.conversation(f.selected.id, context)
  assert(selected)
  expect(await selected.entries({ order: "ascending" }, 100, undefined, context)).toEqual(
    f.before.entries,
  )
  expect(await harness.snapshot(OutboxDoc, context)).toEqual(f.before.outbox)
  expect(await storage.submission(f.before.submission.id, context)).toEqual(f.before.submission)
  expect((await harness.inspect(context)).scheduling).toBe("paused")
  expect(f.env).not.toHaveBeenCalled()
}

describe("session routing document migration", () => {
  it("initializes both routing IDs to root without changing the chat identity on reopen", async () => {
    const f = await fixture()
    const first = await f.open()
    const saved = await upgrade(first.harness)
    expect(saved).toEqual({
      sessionId: expect.any(String),
      mainConversation: 1,
      activeConversation: 1,
      trustKey: "",
    })
    expect(saved.sessionId).not.toBe("")
    await close(first.harness)
    const second = await f.open()
    expect(await upgrade(second.harness)).toEqual(saved)
    expect(f.env).not.toHaveBeenCalled()
  })

  it("migrates the legacy selection once and preserves identity, forks, pending delivery and native input", async () => {
    const f = await legacyFixture()
    for (let iteration = 0; iteration < 3; iteration++) {
      const { harness, storage } = await f.open()
      const commits = vi.fn()
      const observation = harness.observeCommits({ advance: commits, end: () => {} })
      try {
        expect(await upgrade(harness)).toEqual({
          ...identity,
          mainConversation: f.selected.id,
          activeConversation: f.selected.id,
        })
        if (iteration > 0) expect(commits).not.toHaveBeenCalled()
      } finally {
        observation.detach()
      }
      const stored = await sessionDocument(storage)
      expect(stored.record.id).toBe(f.before.session.record.id)
      expect(stored.version).toBe(2)
      await expectPreserved(storage, harness, f)
      await close(harness)
    }
  })

  it("keeps private selection separate from stable main and does not cross chat databases", async () => {
    const f = await legacyFixture()
    const { harness } = await f.open()
    const migrated = await upgrade(harness)
    const root = await harness.root(context)
    await root.commit(async (tx) => {
      ;(await tx.doc(BotSessionDoc)).activeConversation = f.branch.id
    }, context)
    await close(harness)
    const reopened = await f.open()
    expect(await upgrade(reopened.harness)).toEqual({
      ...migrated,
      activeConversation: f.branch.id,
    })
    const peer = await f.open(path.join(f.directory, "peer.sqlite"))
    const peerState = await upgrade(peer.harness)
    expect(peerState.mainConversation).toBe(1)
    expect(peerState.activeConversation).toBe(1)
    expect(peerState.sessionId).not.toBe(migrated.sessionId)
    expect(await peer.harness.snapshot(OutboxDoc, context)).toBeUndefined()
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "2", null])(
    "rejects invalid legacy selection %s and leaves the entire transaction unchanged",
    async (activeConversation) => {
      const f = await fixture()
      const old = await f.open()
      const root = await old.harness.root(context)
      await root.commit(async (tx) => {
        ;(await tx.doc(LegacySessionDoc)).activeConversation = activeConversation
      }, context)
      await close(old.harness)
      const { harness, storage } = await f.open()
      const before = await sessionDocument(storage)
      const reopenedRoot = await harness.root(context)
      await expect(
        reopenedRoot.commit(async (tx) => {
          await tx.doc(OutboxDoc)
          await tx.doc(BotSessionDoc)
        }, context),
      ).rejects.toThrow("Invalid sumire.session state")
      expect(await sessionDocument(storage)).toEqual(before)
      expect(await harness.snapshot(OutboxDoc, context)).toBeUndefined()
      expect((await harness.inspect(context)).scheduling).toBe("paused")
      expect(f.env).not.toHaveBeenCalled()
    },
  )

  it.each<JsonObject>([
    { sessionId: "", trustKey: "fixture-trust", activeConversation: 1 },
    { sessionId: 17, trustKey: "fixture-trust", activeConversation: 1 },
    { sessionId: "fixture-session", activeConversation: 1 },
    { ...identity },
  ])("rejects missing or invalid legacy identity and routing fields: %j", async (value) => {
    expect(() => BotSessionDoc.definition.migrate?.(value, 1)).toThrow(
      "Invalid sumire.session state",
    )
  })

  it("validates already-upgraded routing IDs without changing a valid private selection", () => {
    const valid = { ...identity, mainConversation: 7, activeConversation: 9 }
    expect(validateBotSessionState(valid)).toBe(valid)
    for (const field of ["mainConversation", "activeConversation"])
      for (const value of [undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "7"])
        expect(() => validateBotSessionState({ ...valid, [field]: value })).toThrow(
          "Invalid sumire.session state",
        )
    expect(() => BotSessionDoc.definition.migrate?.(valid, 0)).toThrow(
      "Unsupported sumire.session version",
    )
  })

  it.each(["mainConversation", "activeConversation"])(
    "fails closed before scheduling when an already-v2 %s is invalid",
    async (field) => {
      const f = await fixture()
      const old = await f.open()
      const invalid = defineDoc<JsonObject>({
        checkpointWhen: () => false,
        kind: "sumire.session",
        version: 2,
        scope: "session",
        initial: () => ({ ...identity, activeConversation: 1, mainConversation: 1, [field]: 0 }),
      })
      const root = await old.harness.root(context)
      await root.commit(async (tx) => {
        await tx.doc(invalid)
      }, context)
      await close(old.harness)
      const { harness, storage } = await f.open()
      const before = await sessionDocument(storage)
      await expect(upgrade(harness)).rejects.toThrow("Invalid sumire.session state")
      expect(await sessionDocument(storage)).toEqual(before)
      expect((await harness.inspect(context)).scheduling).toBe("paused")
      expect(f.env).not.toHaveBeenCalled()
    },
  )

  it("restores a closed pre-upgrade backup with the old definition before any new work", async () => {
    const f = await legacyFixture()
    const backup = path.join(f.directory, "pre-upgrade.sqlite")
    await copyFile(f.file, backup)
    const upgraded = await f.open()
    await upgrade(upgraded.harness)
    expect((await sessionDocument(upgraded.storage)).version).toBe(2)
    await expect(upgraded.harness.snapshot(LegacySessionDoc, context)).rejects.toThrow(
      "newer version 2 than 1",
    )
    await close(upgraded.harness)
    await copyFile(backup, f.file)
    const restored = await f.open()
    expect(await sessionDocument(restored.storage)).toEqual(f.before.session)
    expect(await restored.harness.snapshot(LegacySessionDoc, context)).toEqual({
      ...identity,
      activeConversation: f.selected.id,
    })
    await expectPreserved(restored.storage, restored.harness, f)
    expect(await upgrade(restored.harness)).toMatchObject({ mainConversation: f.selected.id })
    await expectPreserved(restored.storage, restored.harness, f)
  })

  it("stores each conversation purpose independently and initializes forks instead of copying purpose", async () => {
    const f = await fixture()
    const { harness } = await f.open()
    const root = await harness.root(context)
    const point = await root.commit(async (tx) => {
      expect((await tx.doc(ConversationPurposeDoc, root.id)).purpose).toBe("main")
      return tx.appendEntry(root.id, { kind: "fixture.point" })
    }, context)
    const article = await harness.createConversation({ ownership: { kind: "ownerless" } }, context)
    const articlePoint = await article.commit(async (tx) => {
      ;(await tx.doc(ConversationPurposeDoc, article.id)).purpose = "article"
      return tx.appendEntry(article.id, { kind: "fixture.article" })
    }, context)
    const reply = await article.fork(articlePoint.id, { ownership: { kind: "ownerless" } }, context)
    await reply.commit(async (tx) => {
      const purpose = await tx.doc(ConversationPurposeDoc, reply.id)
      expect(purpose.purpose).toBe("main")
      purpose.purpose = "reply"
    }, context)
    const branch = await root.fork(point.id, { ownership: { kind: "ownerless" } }, context)
    await branch.commit(async (tx) => {
      expect((await tx.doc(ConversationPurposeDoc, branch.id)).purpose).toBe("main")
    }, context)
    await close(harness)
    const reopened = await f.open()
    for (const [conversation, purpose] of [
      [root, "main"],
      [article, "article"],
      [reply, "reply"],
      [branch, "main"],
    ] as const)
      expect(
        await reopened.harness.snapshot(ConversationPurposeDoc, conversation.id, context),
      ).toEqual({ purpose })
  })

  it("projects v2 selection through the unchanged admin contract without internal state fields", async () => {
    const f = await legacyFixture()
    const { harness, storage } = await f.open()
    await upgrade(harness)
    const root = await harness.root(context)
    await root.commit(async (tx) => {
      ;(await tx.doc(BotSessionDoc)).activeConversation = f.branch.id
    }, context)
    const stored = await sessionDocument(storage)
    const inspect = createDurableInspector(
      storage,
      async (readContext) =>
        (await harness.snapshot(BotSessionDoc, readContext))?.activeConversation,
      123,
    )
    const detail = await inspect(
      parseDurableInspectionQuery(
        new URLSearchParams({
          view: "documents",
          scope: "session",
          objectId: String(stored.record.id),
        }),
      ),
      new AbortController().signal,
    )
    expect(detail.items).toEqual([
      expect.objectContaining({
        kind: "sumire.session",
        version: 2,
        valueState: "available",
        value: { kind: "sumire.session", activeConversation: f.branch.id },
      }),
    ])
    for (const field of ["mainConversation", "sessionId", "trustKey"])
      expect(JSON.stringify(detail)).not.toContain(field)
    const selection = await inspect(
      parseDurableInspectionQuery(new URLSearchParams()),
      new AbortController().signal,
    )
    expect(selection.selectedConversation).toMatchObject({ id: f.branch.id, active: true })
    expect((await harness.snapshot(BotSessionDoc, context))?.mainConversation).toBe(f.selected.id)
  })
})
