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
    hasMore: false,
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
  await expect(f.worker.poll()).rejects.toThrow("POST response lost")
  await f.worker.close()
  f.page.mentions = []
  f.reply.mockResolvedValueOnce({ status: "already-replied" })
  await f.create().poll()
  expect(f.generate).toHaveBeenCalledTimes(1)
  expect(f.reply).toHaveBeenCalledTimes(2)
  expect(f.reply.mock.calls[0]?.slice(0, 2)).toEqual(f.reply.mock.calls[1]?.slice(0, 2))
  expect(f.read("SELECT status FROM mentions")).toEqual([{ status: "sent" }])
})

it("starts with a small overlap and ignores historical comments inside active threads", async () => {
  const f = await fixture()
  f.page.mentions = [
    mention({ source: { kind: "issue-comment", id: 1, updatedAt: "2020-01-01T00:00:00Z" } }),
  ]
  await f.worker.poll()
  expect(f.scan).toHaveBeenCalledWith(
    { since: "2030-01-01T11:58:00.000Z", page: 1, perPage: 20 },
    expect.any(AbortSignal),
  )
  expect(f.generate).not.toHaveBeenCalled()
  expect(f.reply).not.toHaveBeenCalled()
})

it("persists the first-enable cutoff before the first HTTP request, including initial failures and restart", async () => {
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
  expect(f.read("SELECT since FROM cursors")).toEqual([{ since: "2030-01-01T11:58:00.000Z" }])
  await worker.poll()
  expect(f.read("SELECT since FROM cursors")).toEqual([{ since: "2030-01-01T12:08:00.000Z" }])
})

it("does not advance the cursor after the ten-page limit and can deliver already admitted work", async () => {
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
  await expect(f.worker.poll()).rejects.toThrow()
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
  await expect(f.worker.poll()).rejects.toThrow()
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
  await expect(f.worker.poll()).rejects.toThrow()
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
