import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import type { GithubMention, MentionPage } from "@narumitw/sumire-github-notifications"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { githubAccessDigest } from "../src/admin/github-state.js"
import { GithubMentionWorker, type GithubWorkerOptions } from "../src/github/runtime.js"
import type { GitHubToken } from "../src/github-client.js"
import {
  createGitHubFixture,
  deferred,
  githubAccount,
  githubClientId,
  githubSecrets,
  githubToken,
} from "./helpers/github-fixture.js"

const now = Date.parse("2030-01-01T12:00:00Z")
const modelRef = "openai/gpt-6.1-sol"
const refreshedToken: GitHubToken = {
  ...githubToken,
  accessToken: githubSecrets.rotatedAccessToken,
  refreshToken: githubSecrets.rotatedRefreshToken,
}
const cleanup: Array<() => Promise<void>> = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(now)
})
afterEach(async () => {
  try {
    for (const close of cleanup.splice(0).reverse()) await close()
  } finally {
    vi.useRealTimers()
    vi.restoreAllMocks()
  }
})

function fixture(expiresAt = now - 1) {
  const auth = createGitHubFixture()
  const { store, runtime, github } = auth
  const workers: GithubMentionWorker[] = []
  cleanup.push(async () => {
    await Promise.all(workers.map((worker) => worker.close()))
    await auth.close()
  })
  const policy = store.snapshot().policy
  policy.githubNotifications.allowedUsernames = ["trusted-author"]
  policy.models = [modelRef]
  policy.defaults.models = [modelRef]
  policy.defaults.model = modelRef
  policy.defaults.thinking = "off"
  policy.providers = [{ id: "openai", enabled: true, models: [] }]
  store.save(policy, store.snapshot().revision, "42")
  runtime.saveGitHub(
    githubSecrets.accessToken,
    {
      version: 1,
      generation: "worker-auth-fixture",
      rotation: 0,
      clientId: githubClientId,
      account: githubAccount,
      scopes: githubToken.scopes,
      accessDigest: githubAccessDigest(githubSecrets.accessToken),
      expiresAt,
      refreshToken: githubSecrets.refreshToken,
      refreshExpiresAt: now + 86_400_000,
    },
    store.snapshot().revision,
    "42",
  )
  store.applied(store.snapshot().revision, true)
  const resolveToken = vi.spyOn(github, "resolveToken")
  const model = { provider: "openai", id: "gpt-6.1-sol", reasoning: false }
  const modelRuntime = {
    getModel: vi.fn(() => model),
    getPhysicalModel: vi.fn(() => model),
    checkAuth: vi.fn(async () => true),
  } as unknown as ModelRuntime
  const mention: GithubMention = {
    key: `${githubAccount.id}:issue-comment:1:2030-01-01T11:59:30Z`,
    account: githubAccount,
    author: "trusted-author",
    repository: "owner/repo",
    issueNumber: 12,
    title: "Question",
    body: "@fixture-account Explain this example.",
    url: "https://github.com/owner/repo/issues/12#issuecomment-1",
    source: { kind: "issue-comment", id: 1, updatedAt: "2030-01-01T11:59:30Z" },
    threadId: "worker-auth-thread",
  }
  const page: MentionPage = {
    account: githubAccount,
    mentions: [mention],
    hasMore: false,
    pageKey: "fixture-page",
    pollIntervalSeconds: 60,
  }
  const scannedTokens: Array<string | undefined> = []
  const scan = vi.fn<NonNullable<GithubWorkerOptions["client"]>["scan"]>(async () => {
    scannedTokens.push(runtime.readSecret("GH_TOKEN"))
    return structuredClone(page)
  })
  const reply = vi.fn<NonNullable<GithubWorkerOptions["client"]>["reply"]>(async () => ({
    status: "sent",
  }))
  const generate = vi.fn<GithubWorkerOptions["generate"]>(async (_mention, authorize) => {
    authorize()
    return { text: "Saved reply.", model: modelRef }
  })
  const directory = path.join(auth.directory, "worker")
  const options: GithubWorkerOptions = {
    directory,
    store,
    runtime,
    github,
    modelRuntime,
    logger: { warn: vi.fn() },
    client: { scan, reply },
    generate,
  }
  const create = () => {
    const worker = new GithubMentionWorker(options)
    workers.push(worker)
    return worker
  }
  const worker = create()
  const read = (sql: string) => {
    const db = new DatabaseSync(path.join(directory, "state.sqlite"), { readOnly: true })
    try {
      return db.prepare(sql).all()
    } finally {
      db.close()
    }
  }
  const expectIdle = () => {
    expect(scan).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
    expect(reply).not.toHaveBeenCalled()
    expect(modelRuntime.getModel).not.toHaveBeenCalled()
    expect(modelRuntime.checkAuth).not.toHaveBeenCalled()
    for (const table of ["accounts", "cursors", "scans", "mentions"])
      expect(read(`SELECT * FROM ${table}`)).toEqual([])
  }
  return {
    ...auth,
    worker,
    create,
    resolveToken,
    modelRuntime,
    page,
    scan,
    scannedTokens,
    reply,
    generate,
    read,
    expectIdle,
  }
}

it("refreshes expired OAuth before polling and fingerprints only the refreshed token", async () => {
  const f = fixture()
  const before = f.store.snapshot()
  expect(f.runtime.readSecret("GH_TOKEN")).toBeUndefined()
  await expect(f.worker.poll()).resolves.toBe(60)
  expect(f.resolveToken).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal))
  expect(f.transport.refresh).toHaveBeenCalledExactlyOnceWith(
    githubClientId,
    githubSecrets.refreshToken,
    expect.any(AbortSignal),
  )
  expect(f.scannedTokens).toEqual([githubSecrets.rotatedAccessToken])
  expect(f.read("SELECT token_hash,account_id FROM accounts")).toEqual([
    {
      token_hash: githubAccessDigest(githubSecrets.rotatedAccessToken),
      account_id: githubAccount.id,
    },
  ])
  expect(f.read("SELECT response,model,status FROM mentions")).toEqual([
    { response: "Saved reply.", model: modelRef, status: "sent" },
  ])
  expect(f.generate).toHaveBeenCalledOnce()
  expect(f.reply).toHaveBeenCalledOnce()
  expect(f.modelRuntime.checkAuth).toHaveBeenCalledOnce()
  expect(f.store.snapshot()).toEqual(before)
  for (const method of [f.transport.device, f.transport.exchange, f.transport.account])
    expect(method).not.toHaveBeenCalled()
})

it.each(["empty-allowlist", "pending", "failed"] as const)(
  "does not resolve or refresh expired OAuth under %s policy",
  async (gate) => {
    const f = fixture()
    const state = f.store.snapshot()
    if (gate === "empty-allowlist") state.policy.githubNotifications.allowedUsernames = []
    f.store.save(state.policy, state.revision, "42")
    if (gate !== "pending") f.store.applied(f.store.snapshot().revision, gate !== "failed")
    const before = f.store.snapshot()
    const metadata = f.runtime.values.listMetadata()
    const audit = f.store.listAudit(0)
    await expect(f.worker.poll()).resolves.toBe(60)
    expect(f.resolveToken).not.toHaveBeenCalled()
    expect(f.transport.refresh).not.toHaveBeenCalled()
    f.expectIdle()
    expect(f.store.snapshot()).toEqual(before)
    expect(f.runtime.values.listMetadata()).toEqual(metadata)
    expect(f.store.listAudit(0)).toEqual(audit)
  },
)

it("skips enabled polling when no token is configured", async () => {
  const f = fixture()
  f.runtime.remove("GH_TOKEN", f.store.snapshot().revision, "42")
  f.store.applied(f.store.snapshot().revision, true)
  await expect(f.worker.poll()).resolves.toBe(60)
  expect(f.transport.refresh).not.toHaveBeenCalled()
  f.expectIdle()
})

it("does not scan or write worker state after refresh failure", async () => {
  const f = fixture()
  const before = f.store.snapshot()
  f.transport.refresh.mockRejectedValueOnce(new Error("Synthetic refresh failure"))
  await expect(f.worker.poll()).rejects.toThrow("Reconnect GitHub")
  expect(f.transport.refresh).toHaveBeenCalledOnce()
  expect(f.runtime.readSecret("GH_TOKEN")).toBeUndefined()
  expect(f.runtime.githubCredentials()).toMatchObject({
    kind: "oauth",
    state: { reconnectRequired: true },
  })
  f.expectIdle()
  expect(f.store.snapshot()).toEqual(before)
  // Resolver audit/credential writes are required; worker checkpoints are not.
  await expect(f.worker.poll()).rejects.toThrow("Reconnect GitHub")
  expect(f.transport.refresh).toHaveBeenCalledOnce()
  f.expectIdle()
})

it.each(["allowlist", "revision", "pending", "epoch", "shutdown"] as const)(
  "blocks scanning when %s changes during a delayed refresh",
  async (change) => {
    const f = fixture()
    const response = deferred<GitHubToken>()
    const started = deferred<void>()
    cleanup.push(async () => response.resolve(refreshedToken))
    f.transport.refresh.mockImplementationOnce(async () => {
      started.resolve()
      return response.promise
    })
    const polling = f.worker.poll()
    const stopped =
      change === "shutdown"
        ? expect(polling).rejects.toThrow("GitHub credential request was cancelled")
        : expect(polling).rejects.toThrow()
    await started.promise
    f.expectIdle()
    expect(f.resolveToken).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal))
    const signal = f.resolveToken.mock.calls[0]?.[0]
    if (change === "shutdown") {
      // Caller cancellation must not wait for the resolver's shared refresh to finish.
      await f.worker.close()
      expect(signal?.aborted).toBe(true)
    } else if (change === "epoch") {
      f.store.db.exec("UPDATE settings SET epoch=epoch+1 WHERE id=1")
    } else {
      const state = f.store.snapshot()
      if (change === "allowlist") state.policy.githubNotifications.allowedUsernames = []
      f.store.save(state.policy, state.revision, "42")
      if (change !== "pending") f.store.applied(f.store.snapshot().revision, true)
    }
    response.resolve(refreshedToken)
    await stopped
    f.expectIdle()
    expect(f.transport.refresh).toHaveBeenCalledOnce()
    if (change !== "pending" && change !== "shutdown")
      expect(f.runtime.readSecret("GH_TOKEN")).toBe(githubSecrets.rotatedAccessToken)
  },
)

it("retains the same-account checkpoint and saved response across OAuth rotation and restart", async () => {
  const f = fixture(now + 3_600_000)
  f.reply.mockRejectedValueOnce(new Error("Synthetic lost delivery response"))
  await f.worker.poll()
  expect(f.transport.refresh).not.toHaveBeenCalled()
  const originalSince = "2030-01-01T11:58:00.000Z"
  expect(f.read("SELECT since FROM cursors")).toEqual([{ since: originalSince }])
  expect(f.read("SELECT response,status FROM mentions")).toEqual([
    { response: "Saved reply.", status: "pending" },
  ])
  await f.worker.close()
  vi.setSystemTime(now + 3_600_001)
  f.page.mentions = []
  f.scan.mockClear()
  f.scannedTokens.length = 0
  await f.create().poll()
  expect(f.transport.refresh).toHaveBeenCalledOnce()
  expect(f.scan.mock.calls.map(([options]) => options?.since)).toEqual([
    "2030-01-01T12:58:00.001Z",
    originalSince,
  ])
  expect(f.scannedTokens).toEqual([
    githubSecrets.rotatedAccessToken,
    githubSecrets.rotatedAccessToken,
  ])
  expect(f.read("SELECT token_hash FROM accounts ORDER BY rowid")).toEqual([
    { token_hash: githubAccessDigest(githubSecrets.accessToken) },
    { token_hash: githubAccessDigest(githubSecrets.rotatedAccessToken) },
  ])
  expect(f.generate).toHaveBeenCalledOnce()
  expect(f.reply).toHaveBeenCalledTimes(2)
  expect(f.reply.mock.calls[0]?.slice(0, 2)).toEqual(f.reply.mock.calls[1]?.slice(0, 2))
  expect(f.read("SELECT response,status FROM mentions")).toEqual([
    { response: "Saved reply.", status: "sent" },
  ])
  expect(f.read("SELECT since FROM cursors")).toEqual([{ since: "2030-01-01T12:58:00.001Z" }])
})
