import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai/models"
import {
  createRegistry,
  defineDoc,
  defineDocFamily,
  defineExtension,
  defineTask,
  Harness,
  type JsonObject,
  type Storage,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import type { DurableInspectionQuery } from "@narumitw/sumire-contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  createDurableInspector,
  type DurableInspectionStorage,
  parseDurableInspectionQuery,
} from "../src/admin/durable-inspector.js"

const secret = "INSPECTOR_SECRET_SENTINEL"
const Unknown = defineDoc({
  kind: "fixture.unknown",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ secret, large: "x".repeat(512 * 1024) }),
})
const Family = defineDocFamily({
  kind: "fixture.family",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  family: true,
  initial: (seed: string) => ({ seed }),
})
const ReservedFamily = defineDocFamily({
  kind: "pi.agent",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  family: true,
  initial: () => ({ model: { provider: secret, modelId: secret } }),
})
const Outbox = defineDoc({
  kind: "sumire.outbox",
  version: 1,
  scope: "session",
  initial: () => ({ pending: [{ requestId: secret, content: secret }] }),
})
const TaskDoc = defineDoc({
  kind: "fixture.task",
  version: 1,
  scope: "task",
  initial: () => ({ secret }),
})
const SessionDoc = defineDoc({
  kind: "sumire.session",
  version: 1,
  scope: "session",
  initial: () => ({ activeConversation: 1, sessionId: secret, trustKey: secret }),
})
const Usage = defineDoc<JsonObject>({
  kind: "pi.usage",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    models: {
      "fixture/model": {
        input: 2,
        output: 3,
        totalTokens: 5,
        cost: { total: 0.5 },
        secret,
      },
    },
    tools: { [secret]: { input: 7, totalTokens: 7 } },
    secret,
  }),
})
const Agent = defineDoc<JsonObject>({
  kind: "pi.agent",
  version: 1,
  scope: "conversation",
  history: "rewindable",
  fork: "asOf",
  initial: () => ({}),
})
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks()
})

function query(values: Record<string, string | number> = {}): DurableInspectionQuery {
  return parseDurableInspectionQuery(
    new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)])),
  )
}
const signal = () => new AbortController().signal

async function fixture(chatId = 123) {
  const directory = await mkdtemp(path.join(tmpdir(), "sumire-inspector-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const storage = await openNodeSqliteStorage(path.join(directory, "session.sqlite"))
  const effects = vi.fn()
  const reports = vi.fn()
  const env = vi.fn(() => {
    throw new Error("Unexpected execution environment")
  })
  const registry = createRegistry()
  const History = defineTask<string, { phase: "finish"; secret: string }, string>({
    name: "fixture.history",
    version: 1,
    initial: () => ({ phase: "finish", secret }),
    phases: {
      finish: async (_task, runtime, ctx) => {
        effects()
        await runtime.commit(
          () => ({ status: "terminal", outcome: { status: "completed", result: secret } }),
          ctx,
        )
      },
    },
    abort: async (_task, runtime, ctx) => {
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted", reason: secret } }),
        ctx,
      )
    },
  })
  const Pending = defineTask({
    name: "fixture.pending",
    version: 1,
    initial: () => ({ phase: "blocked", secret }),
    phases: {
      blocked: async () => {
        effects()
      },
    },
    abort: async () => {},
  })
  registry.install(defineExtension({ name: "fixture", tasks: [History] }))
  const harness = await Harness.open(
    storage,
    { registry, models: createModels(), env, onReport: reports },
    context,
  )
  cleanups.push(() => harness.close(context))
  const root = await harness.root(context, {
    agent: {
      model: { provider: "fixture", modelId: "model" },
      thinkingLevel: "high",
      instructions: secret,
      cwd: secret,
    },
  })
  const { first, later, pending, completed } = await root.commit(async (tx) => {
    const first = await tx.appendEntry(root.id, {
      kind: "fixture.entry",
      data: { secret, large: "x".repeat(512 * 1024) },
      model: [{ role: "user", content: secret, timestamp: 1 }],
    })
    const later = await tx.appendEntry(root.id, { kind: "fixture.later", data: secret })
    await tx.doc(Unknown, root.id)
    await tx.doc(Family, root.id, secret, secret)
    await tx.doc(ReservedFamily, root.id, secret, null)
    await tx.doc(Outbox)
    await tx.doc(SessionDoc)
    Object.assign(await tx.doc(Usage, root.id), Usage.definition.initial())
    const pending = await tx.createTask(Pending, secret, { ownership: { kind: "conversation" } })
    const completed = await tx.createTask(History, secret, {
      ownership: { kind: "task", taskId: pending },
    })
    await tx.doc(TaskDoc, pending)
    await tx.doc(TaskDoc, completed)
    return { first, later, pending, completed }
  }, context)
  const completedDoc = await storage.findDocument(
    { kind: "fixture.task", scope: { kind: "task", taskId: completed } },
    "current",
    context,
  )
  await harness.waitForTask(completed, context)
  const fork = await root.fork(first.id, { ownership: { kind: "ownerless" } }, context)
  const other = await harness.createConversation(
    { ownership: { kind: "task", taskId: pending } },
    context,
  )
  const reads = {} as Record<keyof DurableInspectionStorage, ReturnType<typeof vi.fn>>
  const methods = [
    "conversation",
    "scanConversations",
    "entry",
    "scanEntries",
    "task",
    "scanTasks",
    "scanDocuments",
    "findDocument",
    "document",
  ] as const
  const subset = Object.fromEntries(
    methods.map((name) => {
      const method = vi.fn((...args: unknown[]) => Reflect.apply(storage[name], storage, args))
      reads[name] = method
      return [name, method]
    }),
  ) as unknown as DurableInspectionStorage
  const active = vi.fn(async () => fork.id)
  const inspect = createDurableInspector(subset, active, chatId)
  return {
    storage,
    harness,
    root,
    fork,
    other,
    first,
    later,
    pending,
    completed,
    completedDoc,
    inspect,
    subset,
    reads,
    active,
    effects,
    env,
    reports,
  }
}

async function snapshot(storage: Storage) {
  const conversations = (await storage.scanConversations({}, 100, undefined, context)).items
  const tasks = (await storage.scanTasks({}, 100, undefined, context)).items
  const scopes = [
    { kind: "session" as const },
    ...conversations.map(({ id: conversationId }) => ({
      kind: "conversation" as const,
      conversationId,
    })),
    ...tasks.map(({ id: taskId }) => ({ kind: "task" as const, taskId })),
  ]
  const documents = []
  for (const scope of scopes) {
    const docs = await storage.scanDocuments({ scope, at: "current" }, 100, undefined, context)
    for (const doc of docs.items) documents.push(await storage.document(doc.id, "current", context))
  }
  const entries = []
  for (const conversation of conversations)
    entries.push(
      await storage.scanEntries({ conversationId: conversation.id }, 100, undefined, context),
    )
  return JSON.stringify({ conversations, tasks, documents, entries })
}

describe("durable metadata field allowlists", () => {
  it("does not spread unknown parent, owner, or document-scope properties", async () => {
    const f = await fixture()
    f.reads.scanConversations.mockImplementationOnce(async () => {
      const page = await f.storage.scanConversations({}, 100, undefined, context)
      return {
        ...page,
        items: page.items.map((value) => ({
          ...value,
          parent: value.parent ? { ...value.parent, secret } : undefined,
          owner: value.owner ? { ...value.owner, secret } : undefined,
        })),
      }
    })
    const conversations = await f.inspect(query(), signal())
    expect(conversations.items.some((value) => value.type === "conversation" && value.parent)).toBe(
      true,
    )
    expect(conversations.items.some((value) => value.type === "conversation" && value.owner)).toBe(
      true,
    )
    expect(JSON.stringify(conversations)).not.toContain(secret)
    f.reads.scanDocuments.mockImplementationOnce(async () => {
      const page = await f.storage.scanDocuments(
        { scope: { kind: "conversation", conversationId: f.root.id }, at: "current" },
        100,
        undefined,
        context,
      )
      return {
        ...page,
        items: page.items.map((value) => ({ ...value, scope: { ...value.scope, secret } })),
      }
    })
    const documents = await f.inspect(
      query({ view: "documents", conversationId: f.root.id }),
      signal(),
    )
    expect(documents.items.length).toBeGreaterThan(0)
    expect(JSON.stringify(documents)).not.toContain(secret)
  })

  it("rejects object payloads in every task metadata scalar and enum", async () => {
    const f = await fixture()
    const row = (await f.storage.scanTasks({ conversationId: f.root.id }, 1, undefined, context))
      .items[0]
    assert.ok(row)
    const payload = { hidden: secret }
    const changes = [
      { id: payload },
      { version: payload },
      { owner: payload },
      { background: payload },
      { abortRequested: payload },
      { startedAt: payload },
      { endedAt: payload },
      { state: { status: payload } },
      { state: { status: "terminal", outcome: { status: payload } } },
    ]
    for (const change of changes) {
      f.reads.scanTasks.mockResolvedValueOnce({ items: [{ ...row, ...change }] })
      await expect(
        f.inspect(query({ view: "tasks", conversationId: f.root.id }), signal()),
      ).rejects.toMatchObject({ status: 503 })
    }
  })

  it("validates conversation IDs, entry timestamps and document versions before serialization", async () => {
    const f = await fixture()
    const payload = { hidden: secret }
    f.reads.scanConversations.mockResolvedValueOnce({ items: [{ ...f.root, id: payload }] })
    await expect(f.inspect(query(), signal())).rejects.toMatchObject({ status: 503 })
    f.reads.scanEntries.mockResolvedValueOnce({
      items: [{ ...f.first, model: [{ role: "user", timestamp: payload, content: secret }] }],
    })
    await expect(
      f.inspect(query({ view: "entries", conversationId: f.root.id }), signal()),
    ).rejects.toMatchObject({ status: 503 })
    const doc = await f.storage.findDocument(
      { kind: "pi.agent", scope: { kind: "conversation", conversationId: f.root.id } },
      "current",
      context,
    )
    assert.ok(doc)
    const stored = await f.storage.document(doc.id, "current", context)
    assert.ok(stored)
    f.reads.document.mockResolvedValueOnce({ ...stored, version: payload })
    await expect(
      f.inspect(
        query({ view: "documents", conversationId: f.root.id, objectId: doc.id }),
        signal(),
      ),
    ).rejects.toMatchObject({ status: 503 })
  })
})

describe("durable inspection query", () => {
  it("uses bounded defaults and rejects unknown, duplicate, and foreign-scope filters", () => {
    expect(query()).toEqual({ view: "conversations", limit: 25 })
    expect(query({ view: "documents", conversationId: 1 }).scope).toBe("conversation")
    for (const input of [
      "view=unknown",
      "limit=101",
      "limit=0",
      "limit=1.5",
      "limit=01",
      "conversationId=-1",
      "view=tasks",
      "view=documents",
      "view=documents&scope=task&conversationId=1",
      "view=documents&scope=session&conversationId=1",
      "view=entries&conversationId=1&taskId=2",
      "scope=session",
      "secret=value",
      "view=conversations&view=tasks",
      "conversationId=9007199254740992",
      "view=documents&scope=conversation&conversationId=1&objectId=2&cursor=x",
      `cursor=${"x".repeat(4097)}`,
      `cursor=${"界".repeat(2000)}`,
      "__proto__=value",
    ])
      expect(() => parseDurableInspectionQuery(new URLSearchParams(input)), input).toThrow()
  })
})

describe("Pi SQLite public read contract and inspector", () => {
  it("reads ancestry, completed history, all scopes and family metadata without writes or effects", async () => {
    const f = await fixture()
    const before = await snapshot(f.storage)
    const commits = vi.spyOn(f.storage, "commit")
    const mint = vi.spyOn(f.storage, "mintId")
    const effects = f.effects.mock.calls.length
    const conversations = await f.inspect(query(), signal())
    expect(conversations.items).toContainEqual(
      expect.objectContaining({
        type: "conversation",
        id: f.fork.id,
        active: true,
        parent: { conversationId: f.root.id, at: f.first.id },
      }),
    )
    expect(conversations.items).toContainEqual(
      expect.objectContaining({
        id: f.other.id,
        owner: { conversationId: f.root.id, taskId: f.pending },
      }),
    )
    const tasks = await f.inspect(query({ view: "tasks", conversationId: f.root.id }), signal())
    expect(tasks.items).toContainEqual(
      expect.objectContaining({
        id: f.completed,
        ownerTaskId: f.pending,
        status: "terminal",
        outcome: "completed",
        startedAt: expect.any(Number),
        endedAt: expect.any(Number),
      }),
    )
    expect(tasks.items).toContainEqual(
      expect.objectContaining({ id: f.pending, status: "pending" }),
    )
    const entries = await f.inspect(query({ view: "entries", conversationId: f.fork.id }), signal())
    expect(entries.items.map(({ id }) => id)).toEqual([f.first.id])
    expect(
      await f.inspect(
        query({ view: "entries", conversationId: f.fork.id, objectId: f.later.id }),
        signal(),
      ),
    ).toMatchObject({ items: [] })
    expect(
      await f.inspect(
        query({ view: "entries", conversationId: f.fork.id, objectId: f.first.id }),
        signal(),
      ),
    ).toMatchObject({ items: [{ id: f.first.id, role: "user" }] })
    const docs = await f.inspect(query({ view: "documents", conversationId: f.root.id }), signal())
    expect(docs.items).toContainEqual(
      expect.objectContaining({ kind: "fixture.family", family: true, valueState: "withheld" }),
    )
    expect(docs.items).toContainEqual(
      expect.objectContaining({ kind: "fixture.unknown", valueState: "withheld" }),
    )
    expect(docs.items).toContainEqual(
      expect.objectContaining({ kind: "pi.agent", valueState: "metadata-only" }),
    )
    const sessionDocs = await f.inspect(query({ view: "documents", scope: "session" }), signal())
    const taskDocs = await f.inspect(
      query({ view: "documents", scope: "task", conversationId: f.root.id, taskId: f.pending }),
      signal(),
    )
    expect(taskDocs.items).toHaveLength(1)
    const retired = await f.inspect(
      query({ view: "documents", scope: "task", conversationId: f.root.id, taskId: f.completed }),
      signal(),
    )
    expect(retired.items).toEqual([])
    assert(f.completedDoc)
    expect(await f.storage.document(f.completedDoc.id, "current", context)).toBeUndefined()
    expect(f.reads.document).not.toHaveBeenCalled()
    const serialized = JSON.stringify([
      conversations,
      tasks,
      entries,
      docs,
      sessionDocs,
      taskDocs,
      retired,
    ])
    expect(serialized).not.toContain(secret)
    expect(serialized.length).toBeLessThan(256 * 1024)
    expect(await snapshot(f.storage)).toBe(before)
    expect(commits).not.toHaveBeenCalled()
    expect(mint).not.toHaveBeenCalled()
    expect(f.effects).toHaveBeenCalledTimes(effects)
    expect(f.env).not.toHaveBeenCalled()
    expect(f.reports).not.toHaveBeenCalled()
    // Native scans do materialize excluded payloads; response bounds do not bound native allocation.
    const native = await f.storage.scanEntries(
      { conversationId: f.root.id },
      100,
      undefined,
      context,
    )
    expect(JSON.stringify(native).length).toBeGreaterThan(512 * 1024)
  })

  it("projects one explicitly approved singleton and never fetches unknown, family, or retired values", async () => {
    const f = await fixture()
    const before = await snapshot(f.storage)
    const docs = await f.inspect(query({ view: "documents", conversationId: f.root.id }), signal())
    for (const item of docs.items) {
      if (item.type !== "document") continue
      const request = query({ view: "documents", conversationId: f.root.id, objectId: item.id })
      if (item.valueState === "withheld") {
        f.reads.findDocument.mockClear()
        await expect(f.inspect(request, signal())).rejects.toMatchObject({ status: 404 })
        expect(f.reads.findDocument.mock.calls.length).toBeLessThanOrEqual(2)
      } else {
        const detail = await f.inspect(request, signal())
        expect(detail.items[0]).toMatchObject({ valueState: "available", version: 1 })
        if (item.kind === "pi.agent")
          expect(detail.items[0]).toMatchObject({
            value: {
              kind: "pi.agent",
              model: { provider: "fixture", modelId: "model" },
              thinkingLevel: "high",
            },
          })
        if (item.kind === "pi.usage")
          expect(detail.items[0]).toMatchObject({
            value: {
              kind: "pi.usage",
              models: { "fixture/model": { input: 2, output: 3, total: 5, cost: { total: 0.5 } } },
              total: { input: 9, output: 3, total: 12 },
            },
          })
        expect(JSON.stringify(detail)).not.toContain(secret)
      }
    }
    expect(f.reads.document).toHaveBeenCalledTimes(2)
    const sessionDocs = await f.inspect(query({ view: "documents", scope: "session" }), signal())
    const item = sessionDocs.items.find(
      (item) => item.type === "document" && item.kind === "sumire.session",
    )
    assert(item)
    const detail = await f.inspect(
      query({ view: "documents", scope: "session", objectId: item.id }),
      signal(),
    )
    expect(detail.items[0]).toMatchObject({
      value: { kind: "sumire.session", activeConversation: 1 },
    })
    expect(JSON.stringify(detail)).not.toContain(secret)
    expect(await snapshot(f.storage)).toBe(before)
  })

  it("rejects foreign and retired document IDs before fetching values, and handles retirement during a read", async () => {
    const f = await fixture()
    const agent = await f.storage.findDocument(
      { kind: "pi.agent", scope: { kind: "conversation", conversationId: f.root.id } },
      "current",
      context,
    )
    assert(agent)
    await expect(
      f.inspect(
        query({ view: "documents", conversationId: f.other.id, objectId: agent.id }),
        signal(),
      ),
    ).rejects.toMatchObject({ status: 404 })
    assert(f.completedDoc)
    await expect(
      f.inspect(
        query({
          view: "documents",
          scope: "task",
          conversationId: f.root.id,
          taskId: f.completed,
          objectId: f.completedDoc.id,
        }),
        signal(),
      ),
    ).rejects.toMatchObject({ status: 404 })
    expect(f.reads.document).not.toHaveBeenCalled()
    const request = query({ view: "documents", conversationId: f.root.id, objectId: agent.id })
    f.reads.document.mockResolvedValueOnce(undefined)
    expect(await f.inspect(request, signal())).toMatchObject({
      items: [{ valueState: "unavailable" }],
    })
    const stored = await f.storage.document(agent.id, "current", context)
    assert(stored)
    f.reads.document.mockResolvedValueOnce({ ...stored, version: 2, value: { secret } })
    expect(await f.inspect(request, signal())).toMatchObject({
      items: [{ valueState: "withheld", withheldReason: "invalid-value" }],
    })
  })

  it("isolates selected conversation/task scopes and chat-bound cursors with overlapping IDs", async () => {
    const f = await fixture()
    const otherChat = await fixture(456)
    expect(f.root.id).toBe(otherChat.root.id)
    expect(
      await f.inspect(
        query({ view: "tasks", conversationId: f.other.id, objectId: f.completed }),
        signal(),
      ),
    ).toMatchObject({ items: [] })
    expect(
      await f.inspect(
        query({ view: "documents", scope: "task", conversationId: f.other.id, taskId: f.pending }),
        signal(),
      ),
    ).toMatchObject({ items: [] })
    expect(
      await f.inspect(
        query({ view: "entries", conversationId: f.other.id, objectId: f.first.id }),
        signal(),
      ),
    ).toMatchObject({ items: [] })
    expect(
      await f.inspect(
        query({ view: "entries", conversationId: 99999, objectId: f.first.id }),
        signal(),
      ),
    ).toMatchObject({ items: [] })
    const page = await f.inspect(query({ limit: 1 }), signal())
    expect(page.items).toHaveLength(1)
    assert(page.nextCursor)
    const next = await f.inspect(query({ limit: 1, cursor: page.nextCursor }), signal())
    expect(next.items[0]?.id).not.toBe(page.items[0]?.id)
    for (const invalid of [
      query({ limit: 2, cursor: page.nextCursor }),
      query({ limit: 1, cursor: `${page.nextCursor}x` }),
      query({ view: "tasks", conversationId: f.root.id, limit: 1, cursor: page.nextCursor }),
    ])
      await expect(f.inspect(invalid, signal())).rejects.toMatchObject({ status: 400 })
    await expect(
      otherChat.inspect(query({ limit: 1, cursor: page.nextCursor }), signal()),
    ).rejects.toMatchObject({ status: 400 })
    const restartedReader = createDurableInspector(f.subset, f.active, 123)
    await expect(
      restartedReader(query({ limit: 1, cursor: page.nextCursor }), signal()),
    ).rejects.toMatchObject({ status: 400 })
    const ownGate = createDurableInspector(f.subset, f.active, 456)
    await expect(
      ownGate(query({ limit: 1, cursor: page.nextCursor }), signal()),
    ).rejects.toMatchObject({ status: 400 })
  })

  it("withholds invalid and oversized approved fields without returning malformed or oversized JSON", async () => {
    const f = await fixture()
    const metadata = await f.storage.findDocument(
      { kind: "pi.agent", scope: { kind: "conversation", conversationId: f.root.id } },
      "current",
      context,
    )
    assert(metadata)
    for (const model of [
      { provider: 7, modelId: "model" },
      { provider: "fixture", modelId: "界".repeat(6000) },
    ]) {
      await f.root.commit(async (tx) => {
        ;(await tx.doc(Agent, f.root.id)).model = model
      }, context)
      const result = await f.inspect(
        query({ view: "documents", conversationId: f.root.id, objectId: metadata.id }),
        signal(),
      )
      expect(result.items[0]).toMatchObject({
        valueState: "withheld",
        withheldReason: typeof model.provider === "number" ? "invalid-value" : "limit",
      })
      expect(JSON.stringify(result)).not.toContain("modelId")
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(256 * 1024)
    }
    await f.root.commit(async (tx) => {
      const value = await tx.doc(Usage, f.root.id)
      value.models = Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [
          `model-${index}-${"x".repeat(4000)}`,
          { input: 1, totalTokens: 1 },
        ]),
      )
    }, context)
    const usage = await f.storage.findDocument(
      { kind: "pi.usage", scope: { kind: "conversation", conversationId: f.root.id } },
      "current",
      context,
    )
    assert(usage)
    expect(
      await f.inspect(
        query({ view: "documents", conversationId: f.root.id, objectId: usage.id }),
        signal(),
      ),
    ).toMatchObject({
      truncated: true,
      items: [{ valueState: "withheld", withheldReason: "limit" }],
    })
  })

  it("bounds serialized metadata pages and resumes the same native page after byte truncation", async () => {
    const f = await fixture()
    await f.root.commit(async (tx) => {
      for (let index = 0; index < 30; index++)
        await tx.appendEntry(f.root.id, {
          kind: `fixture.${index}.${"x".repeat(14000)}`,
          data: secret,
        })
    }, context)
    const first = await f.inspect(
      query({ view: "entries", conversationId: f.root.id, limit: 100 }),
      signal(),
    )
    expect(first.truncated).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(256 * 1024)
    expect(first.items.length).toBeLessThan(30)
    assert(first.nextCursor)
    const second = await f.inspect(
      query({ view: "entries", conversationId: f.root.id, limit: 100, cursor: first.nextCursor }),
      signal(),
    )
    expect(new Set([...first.items, ...second.items].map(({ id }) => id)).size).toBe(
      first.items.length + second.items.length,
    )
    expect(second.items.length + first.items.length).toBe(32)
  })

  it("checks cancellation around native reads and does not release an unresolved operation early", async () => {
    const f = await fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    f.reads.scanConversations.mockImplementationOnce(async () => {
      await gate
      return { items: [], next: undefined }
    })
    const abort = new AbortController()
    let settled = false
    const pending = f.inspect(query(), abort.signal).finally(() => {
      settled = true
    })
    const rejection = expect(pending).rejects.toMatchObject({
      status: 409,
      message: "Durable inspection cancelled",
    })
    await vi.waitFor(() => expect(f.reads.scanConversations).toHaveBeenCalled())
    abort.abort(new Error(secret))
    await Promise.resolve()
    expect(settled).toBe(false)
    await expect(f.inspect(query(), signal())).rejects.toMatchObject({ status: 429 })
    release()
    await rejection
    expect(await f.inspect(query(), signal())).toMatchObject({ state: "loaded" })
    f.reads.scanConversations.mockClear()
    await expect(f.inspect(query(), abort.signal)).rejects.toMatchObject({ status: 409 })
    expect(f.reads.scanConversations).not.toHaveBeenCalled()
  })

  it("sanitizes failed reads and releases admission for a later read", async () => {
    const f = await fixture()
    f.reads.scanConversations.mockRejectedValueOnce(
      new Error(`/private/database.sqlite SQL ${secret}`),
    )
    await expect(f.inspect(query(), signal())).rejects.toMatchObject({
      status: 503,
      message: "Durable inspection read failed",
    })
    expect(await f.inspect(query(), signal())).toMatchObject({ state: "loaded" })
  })
})
