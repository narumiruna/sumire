import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import type { Snapshot } from "@narumitw/sumire-contracts"
import { createGithubMentionClient } from "@narumitw/sumire-github-notifications"
import { initialPolicy } from "@narumitw/sumire-policy"
import { afterEach, expect, it, vi } from "vitest"
import { GithubMentionWorker, type GithubWorkerOptions } from "../src/github/runtime.js"

const now = Date.parse("2030-01-01T12:00:00Z")
const account = { id: 42, login: "sumire-bot" }
const modelRef = "openai/gpt-6.1-sol"
const token = "synthetic-source-limit-token"
const skippedWarning = "GitHub source history exceeded 10 pages; thread was skipped"
const deliveryWarning = "GitHub reply delivery failed; saved response is retained"
const savedPath = "/repos/safe/repo/issues/12"
const laterPath = "/repos/safe/repo/issues/13"
const poisonPath = "/repos/private-owner/poison-pr/issues/99"
const pullPath = "/repos/private-owner/poison-pr/pulls/99"
const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-github-source-limits-"))
  const policy = initialPolicy()
  policy.githubNotifications.allowedUsernames = ["trusted-author"]
  policy.models = [modelRef]
  policy.defaults.models = [modelRef]
  policy.defaults.model = modelRef
  policy.defaults.thinking = "off"
  policy.providers = [{ id: "openai", enabled: true, models: [] }]
  const state: Snapshot = { revision: 1, applied: 1, status: "applied", epoch: 1, policy }
  const model = { provider: "openai", id: "gpt-6.1-sol", reasoning: false }
  const modelRuntime = {
    getModel: vi.fn(() => model),
    getPhysicalModel: vi.fn(() => model),
    checkAuth: vi.fn(async () => true),
  } as unknown as ModelRuntime
  const source = (id: number, body: string, updatedAt = "2030-01-01T12:00:30Z") => ({
    id,
    user: { id: 10, login: "trusted-author" },
    title: "Synthetic source",
    body,
    updated_at: updatedAt,
  })
  const saved = source(12, "@sumire-bot Original pending request.", "2030-01-01T11:59:30Z")
  const later = source(13, "@sumire-bot Later repository request.")
  const poison = source(99, "@sumire-bot Sensitive partial PR body.", "2030-01-01T12:02:30Z")
  const oldReviews = Array.from({ length: 201 }, (_, index) => ({
    ...source(1000 + index, "Old review history."),
    submitted_at: "2029-12-01T00:00:00Z",
  }))
  const comments = new Map<string, unknown[]>([
    [savedPath, []],
    [laterPath, []],
    [poisonPath, [source(300, "@sumire-bot Sensitive partial issue comment.", poison.updated_at)]],
  ])
  const control = {
    poison: false,
    time: now,
    failedPosts: 2,
    onReviewPage: (_page: number) => {},
  }
  const writes: Array<{ path: string; body: string }> = []
  const reviewPages: number[] = []
  const events: string[] = []
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    expect(url.origin).toBe("https://api.github.com")
    events.push(`${init?.method} ${url.pathname}`)
    if (init?.method === "POST") {
      expect([`${savedPath}/comments`, `${laterPath}/comments`]).toContain(url.pathname)
      const payload = JSON.parse(String(init.body)) as { body: string }
      writes.push({ path: url.pathname, body: payload.body })
      if (url.pathname === `${savedPath}/comments` && control.failedPosts-- > 0)
        throw new Error(`Synthetic lost POST response: ${token} ${poison.body}`)
      comments.get(url.pathname.replace(/\/comments$/, ""))?.push({
        id: 900 + writes.length,
        user: account,
        body: payload.body,
        updated_at: "2030-01-01T12:01:00Z",
      })
      return Response.json({ id: 900 + writes.length })
    }
    if (url.pathname === "/user") return Response.json(account)
    if (url.pathname === "/notifications") {
      const threads = control.poison
        ? [
            {
              id: "sensitive-poison-thread",
              repository: "private-owner/poison-pr",
              number: 99,
              pull: true,
            },
            { id: "later-thread", repository: "safe/repo", number: 13, pull: false },
          ]
        : [{ id: "saved-thread", repository: "safe/repo", number: 12, pull: false }]
      return Response.json(
        threads.map((thread) => ({
          id: thread.id,
          reason: "mention",
          repository: { full_name: thread.repository },
          subject: {
            type: thread.pull ? "PullRequest" : "Issue",
            url: `https://api.github.com/repos/${thread.repository}/${thread.pull ? "pulls" : "issues"}/${thread.number}`,
          },
        })),
      )
    }
    if (url.pathname === savedPath) return Response.json(saved)
    if (url.pathname === laterPath) return Response.json(later)
    if (url.pathname === poisonPath) return Response.json(poison)
    for (const [issuePath, rows] of comments)
      if (url.pathname === `${issuePath}/comments`) return Response.json(rows)
    if (url.pathname === `${pullPath}/comments`)
      return Response.json([
        source(400, "@sumire-bot Sensitive partial review comment.", poison.updated_at),
      ])
    if (url.pathname === `${pullPath}/reviews`) {
      expect(url.searchParams.has("since")).toBe(false)
      expect(url.searchParams.get("per_page")).toBe("20")
      const page = Number(url.searchParams.get("page"))
      reviewPages.push(page)
      control.onReviewPage(page)
      return Response.json(oldReviews.slice((page - 1) * 20, page * 20), {
        headers: {
          link: `<https://api.github.com${pullPath}/reviews?page=${page + 1}>; rel="next"`,
        },
      })
    }
    throw new Error("Unexpected synthetic GitHub request")
  })
  const authorize = () => {
    if (state.status !== "applied" || state.applied !== state.revision)
      throw new Error("Synthetic applied policy changed")
  }
  const client = createGithubMentionClient({
    authorize,
    token: () => token,
    allowedUsernames: () => state.policy.githubNotifications.allowedUsernames,
    fetch: fetcher,
  })
  const logger = { warn: vi.fn() }
  const generate = vi.fn<GithubWorkerOptions["generate"]>(async (mention, admit, signal) => {
    signal.throwIfAborted()
    admit()
    return { text: `Saved answer for issue ${mention.issueNumber}.`, model: modelRef }
  })
  const resolveToken = vi.fn(async () => token)
  const options: GithubWorkerOptions = {
    directory,
    store: { snapshot: () => structuredClone(state) },
    runtime: { readSecret: (name) => (name === "GH_TOKEN" ? token : undefined) },
    github: { resolveToken },
    modelRuntime,
    client,
    generate,
    logger,
    now: () => control.time,
  }
  const workers: GithubMentionWorker[] = []
  const create = () => {
    const worker = new GithubMentionWorker(options)
    workers.push(worker)
    return worker
  }
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
  const outbox = () => read("SELECT response,model,status FROM mentions ORDER BY rowid")
  return {
    worker: create(),
    create,
    state,
    control,
    generate,
    resolveToken,
    logger,
    writes,
    reviewPages,
    events,
    read,
    outbox,
  }
}

it("skips an oversized PR across polls and restart without blocking later mentions or the saved outbox", async () => {
  const f = await fixture()
  const saved = { response: "Saved answer for issue 12.", model: modelRef, status: "pending" }
  const later = { response: "Saved answer for issue 13.", model: modelRef, status: "sent" }
  await expect(f.worker.poll()).resolves.toBe(60)
  expect(f.outbox()).toEqual([saved])
  expect(f.logger.warn.mock.calls).toEqual([[deliveryWarning]])
  expect(f.reviewPages).toEqual([])

  f.control.poison = true
  f.control.time += 60_000
  f.events.length = 0
  await expect(f.worker.poll()).resolves.toBe(60)
  expect(f.outbox()).toEqual([saved, later])
  expect(f.events.indexOf(`GET ${pullPath}/reviews`)).toBeLessThan(
    f.events.indexOf(`GET ${laterPath}`),
  )
  expect(f.read("SELECT since FROM cursors")).toEqual([{ since: "2030-01-01T11:59:00.000Z" }])
  expect(f.read("SELECT * FROM scans")).toEqual([])

  await f.worker.close()
  const restarted = f.create()
  f.control.time += 60_000
  await expect(restarted.poll()).resolves.toBe(60)
  expect(f.outbox()).toEqual([{ ...saved, status: "sent" }, later])
  f.control.time += 60_000
  await expect(restarted.poll()).resolves.toBe(60)
  expect(f.outbox()).toEqual([{ ...saved, status: "sent" }, later])
  expect(f.read("SELECT since FROM cursors")).toEqual([{ since: "2030-01-01T12:01:00.000Z" }])
  expect(f.read("SELECT * FROM scans")).toEqual([])
  expect(f.read("SELECT json_extract(mention,'$.repository') AS repository FROM mentions")).toEqual(
    [{ repository: "safe/repo" }, { repository: "safe/repo" }],
  )
  expect(f.generate.mock.calls.map(([mention]) => mention.body)).toEqual([
    "@sumire-bot Original pending request.",
    "@sumire-bot Later repository request.",
  ])
  expect(f.resolveToken).toHaveBeenCalledTimes(4)
  expect(f.reviewPages).toEqual(
    Array.from({ length: 3 }, () => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).flat(),
  )
  const retries = f.writes.filter((write) => write.path === `${savedPath}/comments`)
  expect(retries).toHaveLength(3)
  expect(retries[1]).toEqual(retries[0])
  expect(retries[2]).toEqual(retries[0])
  expect(f.writes.filter((write) => write.path === `${laterPath}/comments`)).toHaveLength(1)
  expect(f.logger.warn.mock.calls).toEqual([
    [deliveryWarning],
    [skippedWarning],
    [deliveryWarning],
    [skippedWarning],
    [skippedWarning],
  ])
})

it("does not skip a policy failure at the source page limit or deliver pending responses", async () => {
  const f = await fixture()
  await f.worker.poll()
  const pending = f.outbox()
  f.control.poison = true
  f.control.onReviewPage = (page) => {
    if (page === 10) f.state.status = "pending"
  }
  f.events.length = 0
  await expect(f.worker.poll()).rejects.toThrow("Synthetic applied policy changed")
  expect(f.reviewPages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  expect(f.events).not.toContain(`GET ${laterPath}`)
  expect(f.outbox()).toEqual(pending)
  expect(f.generate).toHaveBeenCalledOnce()
  expect(f.writes).toHaveLength(1)
  expect(f.logger.warn.mock.calls).toEqual([[deliveryWarning]])
})
