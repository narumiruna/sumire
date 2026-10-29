import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"
import type { Snapshot } from "@narumitw/sumire-contracts"
import { createGithubMentionClient } from "@narumitw/sumire-github-notifications"
import { initialPolicy } from "@narumitw/sumire-policy"
import { expect, it, vi } from "vitest"
import { GithubMentionWorker, type GithubWorkerOptions } from "../src/github/runtime.js"

it.each(["reviews-only", "all-three"] as const)(
  "admits complete ten-page PR histories within the request budget: %s",
  async (histories) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "sumire-github-request-budget-"))
    const token = "synthetic-request-budget-token"
    const account = { id: 42, login: "sumire-bot" }
    const modelRef = "openai/gpt-6.1-sol"
    const updatedAt = "2030-01-01T11:59:30Z"
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
    const issuePath = (number: number) => `/repos/safe/repo/issues/${number}`
    const pullPath = (number: number) => `/repos/safe/repo/pulls/${number}`
    const heavyNumbers = Array.from({ length: 20 }, (_, index) => index + 1)
    const allNumbers = [100, ...heavyNumbers, 21]
    const sources = new Map(
      allNumbers.map((number) => [
        number,
        {
          id: number,
          user: { id: 10, login: "trusted-author" },
          title: `Synthetic request ${number}`,
          body: `@sumire-bot Please handle request ${number}.`,
          updated_at: updatedAt,
        },
      ]),
    )
    const history = Array.from({ length: 200 }, (_, index) => ({
      id: 1000 + index,
      user: { id: 10, login: "trusted-author" },
      body: "Current history without a mention.",
      updated_at: updatedAt,
      submitted_at: updatedAt,
    }))
    const comments = new Map<string, unknown[]>(
      allNumbers.map((number) => [
        `${issuePath(number)}/comments`,
        histories === "all-three" && heavyNumbers.includes(number) ? [...history] : [],
      ]),
    )
    let stage: "saved" | "heavy" | "empty" = "saved"
    let failedPosts = 2
    const writes: Array<{ path: string; body: string }> = []
    const sourcePages: Array<{ path: string; page: number; perPage: number }> = []
    const paginate = (url: URL, rows: unknown[]) => {
      const page = Number(url.searchParams.get("page"))
      const perPage = Number(url.searchParams.get("per_page"))
      const start = (page - 1) * perPage
      const data = rows.slice(start, start + perPage)
      expect(data.length).toBeLessThanOrEqual(20)
      const headers = new Headers()
      if (start + perPage < rows.length) {
        const next = new URL(url)
        next.searchParams.set("page", String(page + 1))
        headers.set("link", `<${next}>; rel="next"`)
      }
      return Response.json(data, { headers })
    }
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input))
      expect(url.origin).toBe("https://api.github.com")
      if (init?.method === "POST") {
        expect(comments.has(url.pathname)).toBe(true)
        const payload = JSON.parse(String(init.body)) as { body: string }
        writes.push({ path: url.pathname, body: payload.body })
        if (url.pathname === `${issuePath(100)}/comments` && failedPosts-- > 0)
          return new Response("Synthetic unavailable write", { status: 503 })
        comments.get(url.pathname)?.push({
          id: 9000 + writes.length,
          user: account,
          body: payload.body,
          updated_at: "2030-01-01T12:00:30Z",
        })
        return Response.json({ id: 9000 + writes.length })
      }
      if (url.pathname === "/user") return Response.json(account)
      if (url.pathname === "/notifications") {
        const numbers = stage === "saved" ? [100] : stage === "heavy" ? [...heavyNumbers, 21] : []
        return paginate(
          url,
          numbers.map((number) => ({
            id: `thread-${number}`,
            reason: "mention",
            repository: { full_name: "safe/repo" },
            subject: {
              type: heavyNumbers.includes(number) ? "PullRequest" : "Issue",
              url: `https://api.github.com${heavyNumbers.includes(number) ? pullPath(number) : issuePath(number)}`,
            },
          })),
        )
      }
      for (const number of allNumbers)
        if (url.pathname === issuePath(number)) return Response.json(sources.get(number))
      let rows = comments.get(url.pathname)
      if (!rows && /^\/repos\/safe\/repo\/pulls\/\d+\/(comments|reviews)$/.test(url.pathname)) {
        rows = histories === "all-three" || url.pathname.endsWith("/reviews") ? history : []
      }
      if (rows) {
        const page = Number(url.searchParams.get("page"))
        const perPage = Number(url.searchParams.get("per_page"))
        sourcePages.push({ path: url.pathname, page, perPage })
        expect(page).toBeGreaterThanOrEqual(1)
        expect(page).toBeLessThanOrEqual(10)
        expect(perPage).toBe(20)
        const since = url.searchParams.get("since")
        if (url.pathname.endsWith("/reviews")) expect(since).toBeNull()
        const filtered = rows.filter((row) => {
          const comment = row as { updated_at: string }
          return !since || Date.parse(comment.updated_at) >= Date.parse(since)
        })
        return paginate(url, filtered)
      }
      throw new Error("Unexpected synthetic GitHub request")
    })
    const client = createGithubMentionClient({
      authorize() {
        if (state.status !== "applied" || state.applied !== state.revision)
          throw new Error("Synthetic policy is not applied")
      },
      token: () => token,
      allowedUsernames: () => state.policy.githubNotifications.allowedUsernames,
      fetch: fetcher,
    })
    const scans: Array<{
      query: Parameters<typeof client.scan>[0]
      result: Awaited<ReturnType<typeof client.scan>>
      requests: number
      pages: typeof sourcePages
    }> = []
    const scan = client.scan
    vi.spyOn(client, "scan").mockImplementation(async (query, signal) => {
      const before = fetcher.mock.calls.length
      const pageStart = sourcePages.length
      const result = await scan(query, signal)
      scans.push({
        query,
        result,
        requests: fetcher.mock.calls.length - before,
        pages: sourcePages.slice(pageStart),
      })
      return result
    })
    const generate = vi.fn<GithubWorkerOptions["generate"]>(async (mention, admit, signal) => {
      signal.throwIfAborted()
      admit()
      return { text: `Saved answer for request ${mention.issueNumber}.`, model: modelRef }
    })
    const logger = { warn: vi.fn() }
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
      now: () => Date.parse("2030-01-01T12:00:00Z"),
    }
    const outbox = () => {
      const db = new DatabaseSync(path.join(directory, "state.sqlite"), { readOnly: true })
      try {
        return db
          .prepare(
            "SELECT json_extract(mention,'$.issueNumber') AS number,response,model,status FROM mentions ORDER BY rowid",
          )
          .all()
      } finally {
        db.close()
      }
    }
    const saved = {
      number: 100,
      response: "Saved answer for request 100.",
      model: modelRef,
      status: "pending",
    }
    let worker = new GithubMentionWorker(options)
    try {
      await expect(worker.poll()).resolves.toBe(60)
      expect(outbox()).toEqual([saved])
      stage = "heavy"
      await expect(worker.poll()).resolves.toBe(60)

      const heavyScans = scans.slice(1, 5)
      expect(heavyScans).toHaveLength(4)
      expect(heavyScans.map(({ query }) => query?.page)).toEqual([1, 2, 3, 4])
      expect(heavyScans.map(({ requests }) => requests)).toEqual(
        Array(4).fill(histories === "all-three" ? 157 : 67),
      )
      expect(heavyScans.flatMap(({ result }) => result.mentions.map((m) => m.issueNumber))).toEqual(
        heavyNumbers,
      )
      const pages = Array.from({ length: 10 }, (_, index) => index + 1)
      for (const discovery of heavyScans) {
        expect(discovery.result.skippedThreads).toBe(0)
        expect(discovery.result.hasMore).toBe(true)
        for (const mention of discovery.result.mentions) {
          expect(mention.source.kind).toBe("issue")
          for (const listPath of [
            `${issuePath(mention.issueNumber)}/comments`,
            `${pullPath(mention.issueNumber)}/comments`,
            `${pullPath(mention.issueNumber)}/reviews`,
          ])
            expect(
              discovery.pages.filter((page) => page.path === listPath).map((p) => p.page),
            ).toEqual(histories === "all-three" || listPath.endsWith("/reviews") ? pages : [1])
        }
      }
      expect(scans[5]?.query?.page).toBe(5)
      expect(scans[5]?.result.mentions.map((mention) => mention.issueNumber)).toEqual([21])
      expect(scans[5]?.result.hasMore).toBe(false)
      expect(outbox()).toEqual([
        saved,
        ...[...heavyNumbers, 21].map((number) => ({
          number,
          response: `Saved answer for request ${number}.`,
          model: modelRef,
          status: "sent",
        })),
      ])
      expect(generate.mock.calls.map(([mention]) => mention.issueNumber)).toEqual(allNumbers)

      // Replies add a 201st issue comment. Do not rescan those histories in this budget test.
      await worker.close()
      stage = "empty"
      worker = new GithubMentionWorker(options)
      await expect(worker.poll()).resolves.toBe(60)
      expect(outbox().map((row) => row.status)).toEqual(Array(22).fill("sent"))
      expect(generate).toHaveBeenCalledTimes(22)
      const savedWrites = writes.filter((write) => write.path === `${issuePath(100)}/comments`)
      expect(savedWrites).toHaveLength(3)
      expect(savedWrites[1]).toEqual(savedWrites[0])
      expect(savedWrites[2]).toEqual(savedWrites[0])
      for (const number of [...heavyNumbers, 21])
        expect(
          writes.filter((write) => write.path === `${issuePath(number)}/comments`),
        ).toHaveLength(1)
      expect(scans.map(({ query }) => query?.perPage)).toEqual(Array(7).fill(5))
      expect(scans.map(({ requests }) => requests)).toEqual([
        4,
        ...Array(4).fill(histories === "all-three" ? 157 : 67),
        4,
        2,
      ])
      expect(
        scans.every(({ requests, result }) => requests <= 157 && result.skippedThreads === 0),
      ).toBe(true)
      expect(sourcePages.every(({ page, perPage }) => page <= 10 && perPage === 20)).toBe(true)
      expect(resolveToken).toHaveBeenCalledTimes(3)
      expect(logger.warn.mock.calls).toEqual([
        ["GitHub reply delivery failed; saved response is retained"],
        ["GitHub reply delivery failed; saved response is retained"],
      ])
    } finally {
      await worker.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
)
