import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import type { Snapshot } from "@narumitw/sumire-contracts"
import type { GithubMention, MentionPage } from "@narumitw/sumire-github-notifications"
import { initialPolicy } from "@narumitw/sumire-policy"
import { afterEach, expect, it, vi } from "vitest"
import { GithubMentionWorker, type GithubWorkerOptions } from "../src/github/runtime.js"

const now = Date.parse("2030-01-01T12:00:00Z")
const account = { id: 42, login: "sumire-bot" }
const mention = (overrides: Partial<GithubMention> = {}): GithubMention => ({
  key: "42:issue-comment:1:2030-01-01T11:59:30Z",
  account,
  author: "trusted-author",
  repository: "owner/repo",
  issueNumber: 12,
  title: "Question",
  body: "@sumire-bot Please explain this.",
  url: "https://github.com/owner/repo/issues/12#issuecomment-1",
  source: { kind: "issue-comment", id: 1, updatedAt: "2030-01-01T11:59:30Z" },
  threadId: "123",
  ...overrides,
})
const anotherMention = () =>
  mention({
    key: "42:issue-comment:2:2030-01-01T11:59:30Z",
    author: "another-author",
    repository: "other/project",
    url: "https://github.com/other/project/issues/12#issuecomment-2",
    source: { kind: "issue-comment", id: 2, updatedAt: "2030-01-01T11:59:30Z" },
  })
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(cleanup.splice(0).map((close) => close()))
})

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-github-worker-"))
  const policy = initialPolicy()
  policy.githubNotifications.allowedUsernames = ["trusted-author"]
  policy.models = ["openai/gpt-6.1-sol"]
  policy.defaults.models = [...policy.models]
  policy.defaults.model = policy.models[0] as string
  policy.providers = [{ id: "openai", enabled: true, models: [] }]
  const state: Snapshot = { revision: 1, applied: 1, status: "applied", epoch: 1, policy }
  const secret = { token: "managed-token" as string | undefined }
  const model = { provider: "openai", id: "gpt-6.1-sol", reasoning: false }
  const modelRuntime = {
    getModel: vi.fn((provider: string, id: string) => ({ ...model, provider, id })),
    getPhysicalModel: vi.fn((provider: string, id: string) => ({ ...model, provider, id })),
    checkAuth: vi.fn(async () => true),
  } as unknown as ModelRuntime
  const page: MentionPage = {
    account,
    mentions: [mention()],
    skippedThreads: 0,
    hasMore: false,
    pageKey: "fixture-page",
    pollIntervalSeconds: 60,
  }
  const scan = vi.fn<NonNullable<GithubWorkerOptions["client"]>["scan"]>(async () =>
    structuredClone(page),
  )
  const reply = vi.fn<NonNullable<GithubWorkerOptions["client"]>["reply"]>(async () => ({
    status: "sent",
  }))
  const generate = vi.fn<GithubWorkerOptions["generate"]>(async () => ({
    text: "Generated **Markdown**.",
    model: "openai/gpt-6.1-sol",
  }))
  const logger = { warn: vi.fn() }
  const options: GithubWorkerOptions = {
    directory,
    store: { snapshot: () => structuredClone(state) },
    runtime: { readSecret: (name) => (name === "GH_TOKEN" ? secret.token : undefined) },
    github: { resolveToken: vi.fn(async () => secret.token) },
    modelRuntime,
    generate,
    logger,
    client: { scan, reply },
    now: () => now,
  }
  const workers: GithubMentionWorker[] = []
  const create = () => {
    const worker = new GithubMentionWorker(options)
    workers.push(worker)
    return worker
  }
  const worker = create()
  cleanup.push(async () => {
    await Promise.all(workers.map((worker) => worker.close()))
    await rm(directory, { recursive: true, force: true })
  })
  const read = (sql: string) => {
    const db = new DatabaseSync(path.join(directory, "state.sqlite"), { readOnly: true })
    try {
      return db.prepare(sql).all()
    } finally {
      db.close()
    }
  }
  return { worker, create, state, secret, page, scan, reply, generate, options, read, logger }
}

it.each(["pending", "failed", "unapplied", "empty", "no-token"])(
  "does not poll, generate, or write when %s",
  async (gate) => {
    const f = await fixture()
    if (gate === "pending" || gate === "failed") f.state.status = gate
    if (gate === "unapplied") f.state.applied = 0
    if (gate === "empty") f.state.policy.githubNotifications.allowedUsernames = []
    if (gate === "no-token") f.secret.token = undefined
    expect(await f.worker.poll()).toBe(60)
    expect(f.scan).not.toHaveBeenCalled()
    expect(f.generate).not.toHaveBeenCalled()
    expect(f.reply).not.toHaveBeenCalled()
  },
)

it("ignores nonallowed authors before admission or model generation", async () => {
  const f = await fixture()
  f.page.mentions = [mention({ author: "stranger" })]
  await f.worker.poll()
  expect(f.generate).not.toHaveBeenCalled()
  expect(f.reply).not.toHaveBeenCalled()
  expect(f.read("SELECT * FROM mentions")).toEqual([])
})

it("accepts case-insensitive authors, persists response before delivery, and deduplicates after restart", async () => {
  const f = await fixture()
  f.page.mentions = [mention({ author: "TRUSTED-AUTHOR" })]
  f.reply.mockImplementationOnce(async () => {
    expect(f.read("SELECT response,status FROM mentions")).toEqual([
      { response: "Generated **Markdown**.", status: "pending" },
    ])
    return { status: "sent" }
  })
  await f.worker.poll()
  expect(f.generate).toHaveBeenCalledTimes(1)
  expect(f.reply).toHaveBeenCalledTimes(1)
  await f.worker.close()
  await f.create().poll()
  expect(f.generate).toHaveBeenCalledTimes(1)
  expect(f.reply).toHaveBeenCalledTimes(1)
})

it("retains the same generated outbox response after ambiguous delivery and restart", async () => {
  const f = await fixture()
  f.reply.mockRejectedValueOnce(new Error("POST response lost"))
  await expect(f.worker.poll()).resolves.toBe(60)
  expect(f.read("SELECT response,model,status FROM mentions")).toEqual([
    { response: "Generated **Markdown**.", model: "openai/gpt-6.1-sol", status: "pending" },
  ])
  await f.worker.close()
  f.page.mentions = []
  f.reply.mockResolvedValueOnce({ status: "already-replied" })
  await f.create().poll()
  expect(f.generate).toHaveBeenCalledTimes(1)
  expect(f.reply).toHaveBeenCalledTimes(2)
  expect(f.reply.mock.calls[0]?.slice(0, 2)).toEqual(f.reply.mock.calls[1]?.slice(0, 2))
  expect(f.read("SELECT status FROM mentions")).toEqual([{ status: "sent" }])
})

it.each(["network failure", "HTTP 500", "uncertain POST"])(
  "isolates %s across authors and repositories and retries saved responses after restart",
  async (failure) => {
    const f = await fixture()
    f.state.policy.githubNotifications.allowedUsernames.push("another-author")
    const first = mention()
    const second = anotherMention()
    const third = anotherMention()
    third.key = "42:issue-comment:3:2030-01-01T11:59:30Z"
    third.source.id = 3
    third.url = "https://github.com/other/project/issues/12#issuecomment-3"
    f.page.mentions = [first, second]
    f.generate.mockImplementation(async (item) => ({
      text: `Response for ${item.key}`,
      model: "openai/gpt-6.1-sol",
    }))
    f.reply.mockRejectedValueOnce(new Error(`${failure}: managed-token private-source-body`))
    await expect(f.worker.poll()).resolves.toBe(60)
    expect(f.reply.mock.calls.map(([item]) => item.repository)).toEqual([
      "owner/repo",
      "other/project",
    ])
    expect(f.read("SELECT response,model,status FROM mentions ORDER BY rowid")).toEqual([
      { response: `Response for ${first.key}`, model: "openai/gpt-6.1-sol", status: "pending" },
      { response: `Response for ${second.key}`, model: "openai/gpt-6.1-sol", status: "sent" },
    ])
    f.page.mentions = [third]
    f.reply.mockRejectedValueOnce(new Error(`${failure}: managed-token private-source-body`))
    await expect(f.worker.poll()).resolves.toBe(60)
    expect(f.reply.mock.calls.map(([item]) => item.key)).toEqual([
      first.key,
      second.key,
      first.key,
      third.key,
    ])
    expect(f.generate).toHaveBeenCalledTimes(3)
    await f.worker.close()
    f.page.mentions = []
    f.reply.mockResolvedValueOnce({ status: "already-replied" })
    await f.create().poll()
    expect(f.generate).toHaveBeenCalledTimes(3)
    expect(f.reply).toHaveBeenCalledTimes(5)
    const original = f.reply.mock.calls[0]?.slice(0, 2)
    expect(f.reply.mock.calls[2]?.slice(0, 2)).toEqual(original)
    expect(f.reply.mock.calls[4]?.slice(0, 2)).toEqual(original)
    expect(f.read("SELECT status FROM mentions ORDER BY rowid")).toEqual([
      { status: "sent" },
      { status: "sent" },
      { status: "sent" },
    ])
    expect(f.logger.warn.mock.calls).toEqual([
      ["GitHub reply delivery failed; saved response is retained"],
      ["GitHub reply delivery failed; saved response is retained"],
    ])
  },
)

it.each([
  "token",
  "applied-policy",
  "unapplied",
  "revision",
  "epoch",
  "author",
  "model",
  "provider",
  "response-model",
])("stops later work when %s changes during a failed delivery", async (change) => {
  const f = await fixture()
  f.state.policy.githubNotifications.allowedUsernames.push("another-author")
  f.page.mentions.push(anotherMention())
  const failure = new Error("sensitive delivery error: managed-token")
  f.reply.mockImplementationOnce(async () => {
    if (change === "token") f.secret.token = "rotated-token"
    if (change === "applied-policy") f.state.status = "pending"
    if (change === "unapplied") f.state.applied = 0
    if (change === "revision") {
      f.state.revision++
      f.state.applied++
    }
    if (change === "epoch") f.state.epoch++
    if (change === "author")
      f.state.policy.githubNotifications.allowedUsernames = ["another-author"]
    if (change === "model") f.state.policy.models = []
    if (change === "provider") f.state.policy.providers = []
    if (change === "response-model") {
      f.state.policy.models = ["openai/other-model"]
      f.state.policy.defaults.models = [...f.state.policy.models]
      f.state.policy.defaults.model = "openai/other-model"
    }
    throw failure
  })
  const polling = f.worker.poll()
  await expect(polling).rejects.toBeInstanceOf(Error)
  await expect(polling).rejects.not.toBe(failure)
  expect(f.generate).toHaveBeenCalledTimes(1)
  expect(f.reply).toHaveBeenCalledTimes(1)
  expect(f.read("SELECT response,model,status FROM mentions ORDER BY rowid")).toEqual([
    { response: "Generated **Markdown**.", model: "openai/gpt-6.1-sol", status: "pending" },
    { response: null, model: null, status: "pending" },
  ])
  expect(f.logger.warn).not.toHaveBeenCalled()
})

it("propagates shutdown during a failed delivery without starting later work", async () => {
  const f = await fixture()
  f.state.policy.githubNotifications.allowedUsernames.push("another-author")
  f.page.mentions.push(anotherMention())
  let entered = () => {}
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  f.reply.mockImplementationOnce(async (_mention, _response, signal) => {
    entered()
    return new Promise((_resolve, reject) =>
      signal?.addEventListener(
        "abort",
        () => reject(new Error("sensitive delivery error: managed-token")),
        { once: true },
      ),
    )
  })
  const polling = f.worker.poll()
  const stopped = expect(polling).rejects.toMatchObject({ name: "AbortError" })
  await started
  await f.worker.close()
  await stopped
  expect(f.generate).toHaveBeenCalledTimes(1)
  expect(f.reply).toHaveBeenCalledTimes(1)
  expect(f.read("SELECT response,model,status FROM mentions ORDER BY rowid")).toEqual([
    { response: "Generated **Markdown**.", model: "openai/gpt-6.1-sol", status: "pending" },
    { response: null, model: null, status: "pending" },
  ])
  expect(f.logger.warn).not.toHaveBeenCalled()
})

it("starts with a small overlap and ignores historical comments inside active threads", async () => {
  const f = await fixture()
  f.page.mentions = [
    mention({ source: { kind: "issue-comment", id: 1, updatedAt: "2020-01-01T00:00:00Z" } }),
  ]
  await f.worker.poll()
  expect(f.scan).toHaveBeenCalledWith(
    { since: "2030-01-01T11:58:00.000Z", page: 1, perPage: 5 },
    expect.any(AbortSignal),
  )
  expect(f.generate).not.toHaveBeenCalled()
  expect(f.reply).not.toHaveBeenCalled()
})

it("persists the first-enable cutoff before the first notification request, including initial failures and restart", async () => {
  const f = await fixture()
  f.scan.mockRejectedValueOnce(new Error("GitHub unavailable"))
  await expect(f.worker.poll()).rejects.toThrow("GitHub unavailable")
  await f.worker.close()
  f.options.now = () => now + 600_000
  await f.create().poll()
  expect(f.scan.mock.calls[1]?.[0]?.since).toBe("2030-01-01T11:58:00.000Z")
  expect(f.generate).toHaveBeenCalledTimes(1)
})

it("advances the cursor only after all bounded pages succeed, preserving it across failures and restart", async () => {
  const f = await fixture()
  await f.worker.poll()
  await f.worker.close()
  const later = now + 600_000
  f.options.now = () => later
  f.scan.mockResolvedValueOnce({ ...f.page, mentions: [], hasMore: true })
  f.scan.mockRejectedValueOnce(new Error("page 2 failed"))
  const worker = f.create()
  await expect(worker.poll()).rejects.toThrow("page 2 failed")
  f.scan.mockResolvedValueOnce({ ...f.page, hasMore: true })
  expect(f.read("SELECT since FROM cursors")).toEqual([{ since: "2030-01-01T11:58:00.000Z" }])
  await worker.poll()
  expect(f.scan.mock.calls.at(-1)?.[0]?.page).toBe(2)
  expect(f.read("SELECT since FROM cursors")).toEqual([{ since: "2030-01-01T12:08:00.000Z" }])
  expect(f.read("SELECT * FROM scans")).toEqual([])
})

it("saves a continuation after the ten-page limit and can deliver already admitted work", async () => {
  const f = await fixture()
  await f.worker.poll()
  await f.worker.close()
  f.options.now = () => now + 600_000
  f.page.hasMore = true
  f.scan.mockClear()
  await f.create().poll()
  expect(f.scan).toHaveBeenCalledTimes(10)
  expect(f.read("SELECT since FROM cursors")).toEqual([{ since: "2030-01-01T11:58:00.000Z" }])
  expect(f.logger.warn).toHaveBeenCalledWith(expect.stringContaining("10 pages"))
  expect(f.read("SELECT page,checkpoint FROM scans")).toEqual([
    { page: 10, checkpoint: "2030-01-01T12:08:00.000Z" },
  ])
})

it("drains 201 entries across bounded polls and restart without moving the original scan cutoff", async () => {
  const f = await fixture()
  f.page.mentions = []
  await f.worker.poll()
  await f.worker.close()
  f.options.now = () => now + 600_000
  const backlog = Array.from({ length: 201 }, (_, index) =>
    mention({ key: `backlog-${index}`, source: { ...mention().source, id: index + 1 } }),
  )
  f.scan.mockImplementation(async (query) => {
    const size = query?.perPage ?? 5
    const offset = ((query?.page ?? 1) - 1) * size
    const items = backlog.slice(offset, offset + size)
    return {
      ...f.page,
      mentions: items,
      pageKey: JSON.stringify(items.map((item) => item.key)),
      hasMore: offset + size < backlog.length,
    }
  })
  f.scan.mockClear()
  const first = f.create()
  await first.poll()
  expect(f.scan.mock.calls.map(([query]) => query?.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  expect(f.generate).toHaveBeenCalledTimes(50)
  expect(f.reply).toHaveBeenCalledTimes(50)
  await first.close()
  f.options.now = () => now + 1_200_000
  const second = f.create()
  for (let pass = 0; pass < 4; pass++) {
    f.scan.mockClear()
    await second.poll()
    expect(f.scan.mock.calls.length).toBeLessThanOrEqual(10)
    expect(f.scan.mock.calls.every(([query]) => query?.perPage === 5)).toBe(true)
    if (pass === 0) expect(f.scan.mock.calls[0]?.[0]?.page).toBe(10)
    if (pass < 3)
      expect(f.read("SELECT since FROM cursors")).toEqual([{ since: "2030-01-01T11:58:00.000Z" }])
  }
  expect(f.scan.mock.calls.at(-1)?.[0]).toEqual({
    since: "2030-01-01T11:58:00.000Z",
    page: 41,
    perPage: 5,
  })
  expect(f.generate).toHaveBeenCalledTimes(201)
  expect(f.reply).toHaveBeenCalledTimes(201)
  expect(f.read("SELECT status,COUNT(*) AS count FROM mentions GROUP BY status")).toEqual([
    { status: "sent", count: 201 },
  ])
  expect(f.read("SELECT since FROM cursors")).toEqual([{ since: "2030-01-01T12:08:00.000Z" }])
  expect(f.read("SELECT * FROM scans")).toEqual([])

  // Activity during the continued scan must remain inside the next scan's overlap.
  f.scan.mockResolvedValueOnce({
    ...f.page,
    mentions: [
      mention({
        key: "during-scan",
        source: { ...mention().source, updatedAt: "2030-01-01T12:15:00Z" },
      }),
    ],
  })
  await second.poll()
  expect(f.scan.mock.calls.at(-1)?.[0]).toEqual({
    since: "2030-01-01T12:08:00.000Z",
    page: 1,
    perPage: 5,
  })
  expect(f.generate).toHaveBeenCalledTimes(202)
})

it.each(["deletion", "insertion"])(
  "restarts a moved page boundary after notification %s without skipping the backlog",
  async (change) => {
    const f = await fixture()
    f.page.mentions = []
    await f.worker.poll()
    await f.worker.close()
    f.options.now = () => now + 600_000
    const backlog = Array.from({ length: 201 }, (_, index) => mention({ key: `backlog-${index}` }))
    f.scan.mockImplementation(async (query) => {
      const size = query?.perPage ?? 5
      const offset = ((query?.page ?? 1) - 1) * size
      const items = backlog.slice(offset, offset + size)
      return {
        ...f.page,
        mentions: items,
        pageKey: JSON.stringify(items.map((item) => item.key)),
        hasMore: offset + size < backlog.length,
      }
    })
    const worker = f.create()
    await worker.poll()
    expect(f.generate).toHaveBeenCalledTimes(50)
    if (change === "deletion") backlog.shift()
    else backlog.unshift(mention({ key: "new-activity" }))
    f.options.now = () => now + 1_200_000
    f.scan.mockClear()
    await worker.poll()
    expect(f.scan.mock.calls.map(([query]) => query?.page)).toEqual([10, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    for (let pass = 0; pass < 4; pass++) {
      f.scan.mockClear()
      await worker.poll()
      expect(f.scan.mock.calls.length).toBeLessThanOrEqual(10)
    }
    expect(f.generate.mock.calls.map(([item]) => item.key)).toContain("backlog-200")
    expect(f.generate).toHaveBeenCalledTimes(change === "deletion" ? 201 : 202)
    expect(f.reply).toHaveBeenCalledTimes(change === "deletion" ? 201 : 202)
    expect(f.read("SELECT * FROM scans")).toEqual([])
    expect(f.read("SELECT since FROM cursors")).toEqual([{ since: "2030-01-01T12:08:00.000Z" }])
  },
)

it("resumes the failed page after restart and retains its original cutoff", async () => {
  const f = await fixture()
  f.scan.mockResolvedValueOnce({ ...f.page, hasMore: true })
  f.scan.mockRejectedValueOnce(new Error("page 2 failed"))
  await expect(f.worker.poll()).rejects.toThrow("page 2 failed")
  expect(f.read("SELECT page,checkpoint FROM scans")).toEqual([
    { page: 1, checkpoint: "2030-01-01T11:58:00.000Z" },
  ])
  await f.worker.close()
  f.options.now = () => now + 600_000
  f.scan.mockResolvedValueOnce({ ...f.page, hasMore: true })
  await f.create().poll()
  expect(f.scan.mock.calls.slice(-2).map(([query]) => query?.page)).toEqual([1, 2])
  expect(f.generate).toHaveBeenCalledTimes(1)
  expect(f.read("SELECT since FROM cursors")).toEqual([{ since: "2030-01-01T11:58:00.000Z" }])
  expect(f.read("SELECT * FROM scans")).toEqual([])
})

it("keeps scan continuations account-owned across token rotation", async () => {
  const f = await fixture()
  f.page.hasMore = true
  await f.worker.poll()
  expect(f.read("SELECT account_id,page FROM scans")).toEqual([{ account_id: 42, page: 10 }])
  await f.worker.close()
  f.secret.token = "other-account-token"
  f.page.account = { id: 99, login: "other-bot" }
  f.page.mentions = []
  f.page.hasMore = false
  f.scan.mockClear()
  const worker = f.create()
  await worker.poll()
  expect(f.scan.mock.calls[0]?.[0]?.page).toBe(1)
  expect(f.read("SELECT account_id,page FROM scans")).toEqual([{ account_id: 42, page: 10 }])

  f.secret.token = "rotated-original-account-token"
  f.page.account = account
  f.scan.mockClear()
  await worker.poll()
  expect(f.scan.mock.calls.map(([query]) => query?.page)).toEqual([1, 10])
  expect(f.read("SELECT * FROM scans")).toEqual([])
  expect(f.generate).toHaveBeenCalledTimes(1)
  expect(f.reply).toHaveBeenCalledTimes(1)
})

it.each(["allowlist", "token", "pending", "revision"])(
  "blocks in-flight scan results after %s changes",
  async (change) => {
    const f = await fixture()
    f.scan.mockImplementationOnce(async () => {
      if (change === "allowlist") f.state.policy.githubNotifications.allowedUsernames = []
      if (change === "token") f.secret.token = "different-token"
      if (change === "pending") f.state.status = "pending"
      if (change === "revision") {
        f.state.revision++
        f.state.applied++
      }
      return f.page
    })
    await expect(f.worker.poll()).rejects.toThrow()
    expect(f.generate).not.toHaveBeenCalled()
    expect(f.reply).not.toHaveBeenCalled()
    expect(f.read("SELECT * FROM mentions")).toEqual([])
  },
)

it.each(["author", "token", "model", "provider", "pending"])(
  "blocks delivery when %s changes during generation",
  async (change) => {
    const f = await fixture()
    f.generate.mockImplementationOnce(async () => {
      if (change === "author")
        f.state.policy.githubNotifications.allowedUsernames = ["another-author"]
      if (change === "token") f.secret.token = "different-token"
      if (change === "model") f.state.policy.models = []
      if (change === "provider") {
        const provider = f.state.policy.providers[0]
        if (provider) provider.enabled = false
      }
      if (change === "pending") f.state.status = "pending"
      f.state.revision++
      f.state.applied++
      return { text: "Not delivered", model: "openai/gpt-6.1-sol" }
    })
    await expect(f.worker.poll()).rejects.toThrow()
    expect(f.generate).toHaveBeenCalledTimes(1)
    expect(f.reply).not.toHaveBeenCalled()
  },
)

it("keeps removed-author outbox work blocked even when another author enables polling", async () => {
  const f = await fixture()
  f.reply.mockRejectedValueOnce(new Error("delivery failed"))
  await expect(f.worker.poll()).resolves.toBe(60)
  f.state.policy.githubNotifications.allowedUsernames = ["another-author"]
  f.page.mentions = []
  await f.worker.poll()
  expect(f.generate).toHaveBeenCalledTimes(1)
  expect(f.reply).toHaveBeenCalledTimes(1)
  expect(f.read("SELECT status FROM mentions")).toEqual([{ status: "pending" }])
})

it("never sends old-account work with a different authenticated account, and resumes on same-account rotation", async () => {
  const f = await fixture()
  f.reply.mockRejectedValueOnce(new Error("delivery failed"))
  await expect(f.worker.poll()).resolves.toBe(60)
  f.secret.token = "other-account-token"
  f.page.account = { id: 99, login: "other-bot" }
  f.page.mentions = []
  await f.worker.poll()
  expect(f.reply).toHaveBeenCalledTimes(1)
  f.secret.token = "rotated-original-account-token"
  f.page.account = account
  await f.worker.poll()
  expect(f.reply).toHaveBeenCalledTimes(2)
  expect(f.generate).toHaveBeenCalledTimes(1)
})

it.each(["model-global", "model-default", "provider", "auth"])(
  "does not generate or deliver without %s authorization",
  async (gate) => {
    const f = await fixture()
    if (gate === "model-global") f.state.policy.models = []
    if (gate === "model-default") f.state.policy.defaults.models = []
    if (gate === "provider") f.state.policy.providers = []
    if (gate === "auth")
      vi.mocked(f.options.modelRuntime.checkAuth).mockResolvedValue(false as never)
    await expect(f.worker.poll()).rejects.toThrow()
    if (gate !== "auth") expect(f.generate).not.toHaveBeenCalled()
    expect(f.reply).not.toHaveBeenCalled()
  },
)

it("does not create another model turn for a terminal empty generation", async () => {
  const f = await fixture()
  f.generate.mockResolvedValueOnce(undefined)
  await f.worker.poll()
  await f.worker.poll()
  expect(f.generate).toHaveBeenCalledTimes(1)
  expect(f.reply).not.toHaveBeenCalled()
  expect(f.read("SELECT status FROM mentions")).toEqual([{ status: "failed" }])
})

it("shuts down an in-flight scan, then closes the state store idempotently", async () => {
  const f = await fixture()
  let entered = () => {}
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  f.scan.mockImplementationOnce(async (_query, signal) => {
    entered()
    return new Promise((_resolve, reject) =>
      signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
    )
  })
  f.worker.start()
  await started
  await f.worker.close()
  await f.worker.close()
  expect(f.generate).not.toHaveBeenCalled()
  expect(f.reply).not.toHaveBeenCalled()
})

it("shuts down generation without delivery and retains admitted work for restart", async () => {
  const f = await fixture()
  let entered = () => {}
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  f.generate.mockImplementationOnce(async (_mention, _authorize, signal) => {
    entered()
    return new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
    )
  })
  f.worker.start()
  await started
  await f.worker.close()
  expect(f.reply).not.toHaveBeenCalled()
  await f.create().poll()
  expect(f.generate).toHaveBeenCalledTimes(2)
  expect(f.reply).toHaveBeenCalledTimes(1)
})

it("blocks an existing outbox response if its model is no longer allowed, even when a new default is valid", async () => {
  const f = await fixture()
  f.reply.mockRejectedValueOnce(new Error("delivery failed"))
  await expect(f.worker.poll()).resolves.toBe(60)
  f.state.policy.models = ["openai/other-model"]
  f.state.policy.defaults.models = [...f.state.policy.models]
  f.state.policy.defaults.model = "openai/other-model"
  f.page.mentions = []
  await f.worker.poll()
  expect(f.generate).toHaveBeenCalledTimes(1)
  expect(f.reply).toHaveBeenCalledTimes(1)
  expect(f.read("SELECT response,model,status FROM mentions")).toEqual([
    { response: "Generated **Markdown**.", model: "openai/gpt-6.1-sol", status: "pending" },
  ])
})

it.each(["scan", "generation"])(
  "interrupts in-flight %s within one second of an applied policy change",
  async (stage) => {
    const f = await fixture()
    let entered = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    if (stage === "scan")
      f.scan.mockImplementationOnce(async (_query, signal) => {
        entered()
        return new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
        )
      })
    else
      f.generate.mockImplementationOnce(async (_mention, _authorize, signal) => {
        entered()
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
        )
      })
    vi.useFakeTimers()
    const polling = f.worker.poll()
    const stopped = expect(polling).rejects.toThrow("cancelled")
    await started
    f.state.revision++
    f.state.applied++
    f.secret.token = "rotated-token"
    await vi.advanceTimersByTimeAsync(1000)
    await stopped
    expect(f.reply).not.toHaveBeenCalled()
  },
)

it("rejects page identity changes without advancing the cursor or generating", async () => {
  const f = await fixture()
  f.scan.mockResolvedValueOnce({ ...f.page, hasMore: true })
  f.scan.mockResolvedValueOnce({ ...f.page, account: { id: 99, login: "another-bot" } })
  await expect(f.worker.poll()).rejects.toThrow("account changed")
  expect(f.generate).not.toHaveBeenCalled()
  expect(f.reply).not.toHaveBeenCalled()
  expect(f.read("SELECT since FROM cursors")).toEqual([{ since: "2030-01-01T11:58:00.000Z" }])
})

it("honors server poll intervals and cancels an idle wait on shutdown", async () => {
  const f = await fixture()
  f.page.mentions = []
  f.page.pollIntervalSeconds = 120
  expect(await f.worker.poll()).toBe(120)
  f.worker.start()
  await vi.waitFor(() => expect(f.scan).toHaveBeenCalledTimes(2))
  await f.worker.close()
  expect(f.scan).toHaveBeenCalledTimes(2)
})
