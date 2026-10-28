import { describe, expect, it } from "vitest"
import type { MentionQuery } from "../src/index.js"
import {
  account,
  issuePath,
  json,
  notification,
  pullPath,
  repository,
  setup,
  source,
  timestamp,
  tokenValue,
} from "./fixtures.js"

describe("mention scans", () => {
  it("resolves the account before notifications, uses bounded authenticated GETs, and projects sources", async () => {
    const { client, state, fetcher } = setup()
    state.comments = [source()]
    const result = await client.scan({ since: timestamp, page: 2, perPage: 5 })
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.github.com/user",
      `https://api.github.com/notifications?all=true&page=2&per_page=5&since=${encodeURIComponent(timestamp)}`,
      `https://api.github.com${issuePath}`,
      `https://api.github.com${issuePath}/comments?per_page=20&page=1&since=${encodeURIComponent(timestamp)}`,
    ])
    for (const [, init] of fetcher.mock.calls) {
      expect(init).toMatchObject({
        method: "GET",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${tokenValue}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      })
      expect(init?.signal).toBeInstanceOf(AbortSignal)
    }
    expect(result).toMatchObject({
      account,
      hasMore: false,
      pollIntervalSeconds: 60,
      mentions: [
        {
          account,
          author: "Alice",
          repository,
          issueNumber: 12,
          title: "Source title",
          body: source().body,
          url: `https://github.com/${repository}/issues/12#issuecomment-201`,
          source: { kind: "issue-comment", id: 201, updatedAt: timestamp },
          threadId: "thread-1",
        },
      ],
    })
    expect(result.mentions[0]?.key).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(result)).not.toContain(tokenValue)
    expect(JSON.stringify(result)).not.toContain("untrusted-extra-field")
    expect(JSON.stringify(result)).not.toContain("untrusted.invalid")
  })

  it("uses source authors, not repository owners or the latest notification actor", async () => {
    const { state, client } = setup()
    state.allowed = ["aLiCe"]
    state.comments = [source(201), source(202, "unapproved-latest-actor")]
    expect((await client.scan()).mentions.map((item) => item.source.id)).toEqual([201])
    state.allowed = ["repo-owner", "unapproved-latest-actor"]
    state.comments = [source(201)]
    expect((await client.scan()).mentions).toEqual([])
  })

  it("returns every admitted earlier comment, even when the latest comment is unapproved", async () => {
    const { state, client } = setup()
    state.comments = [source(201), source(202), source(203, "mallory")]
    expect((await client.scan()).mentions.map((item) => item.source.id)).toEqual([201, 202])
  })

  it("finds issue/PR bodies, issue comments, inline comments, and reviews", async () => {
    const { state, client } = setup()
    state.notifications = [notification("PullRequest")]
    state.issue = source(12)
    state.comments = [source(201)]
    state.reviewComments = [source(301)]
    state.reviews = [source(401)]
    const mentions = (await client.scan()).mentions
    expect(mentions.map((item) => [item.source.kind, item.source.id, item.url])).toEqual([
      ["issue", 12, `https://github.com/${repository}/pull/12`],
      ["issue-comment", 201, `https://github.com/${repository}/pull/12#issuecomment-201`],
      ["review-comment", 301, `https://github.com/${repository}/pull/12#discussion_r301`],
      ["review", 401, `https://github.com/${repository}/pull/12#pullrequestreview-401`],
    ])
  })

  it.each(["subscribed", "team_mention", "review_requested", "assign", "author", "manual"])(
    "ignores reason=%s without reading source bodies",
    async (reason) => {
      const { state, client, fetcher } = setup()
      state.notifications = [notification("Issue", reason)]
      state.issue = source(12)
      expect((await client.scan()).mentions).toEqual([])
      expect(fetcher).toHaveBeenCalledTimes(2)
    },
  )

  it("ignores unsupported notification subjects and deduplicates repeated threads and sources", async () => {
    const { state, client, fetcher } = setup()
    state.notifications = [
      notification("Discussion"),
      notification(),
      notification("Issue", "mention", "thread-2"),
    ]
    state.comments = [source(201), source(201)]
    expect((await client.scan()).mentions).toHaveLength(1)
    expect(fetcher).toHaveBeenCalledTimes(4)
  })

  it.each([
    "no mention",
    "@sumire-bot-other",
    "@sumire-bot/team",
    "@org/sumire-bot",
    "name@sumire-bot.example",
    "@@sumire-bot",
  ])("does not emit a source without a direct mention: %s", async (body) => {
    const { state, client } = setup()
    state.comments = [source(201, "Alice", body)]
    expect((await client.scan()).mentions).toEqual([])
  })

  it("does not emit self mentions even when the account is allowed", async () => {
    const { state, client } = setup()
    state.allowed = ["SUMIRE-BOT"]
    state.comments = [source(201, "SuMiRe-BoT")]
    expect((await client.scan()).mentions).toEqual([])
  })

  it("filters by source update time, including review submission time", async () => {
    const { state, client } = setup()
    state.notifications = [notification("PullRequest")]
    state.comments = [source(201), { ...source(202), updated_at: "2025-12-31T23:59:59Z" }]
    state.reviews = [{ ...source(401), submitted_at: "2025-12-31T23:59:59Z" }]
    expect(
      (await client.scan({ since: timestamp })).mentions.map((item) => item.source.id),
    ).toEqual([201])
  })

  it("keeps source identity stable across notification metadata and username casing", async () => {
    const { state, client } = setup()
    state.comments = [source()]
    const first = (await client.scan()).mentions[0]
    state.notifications = [
      {
        ...notification(),
        id: "different-thread-id",
        subject: {
          ...notification().subject,
          title: "Changed notification title",
        },
      },
    ]
    state.comments = [source(201, "ALICE")]
    const second = (await client.scan()).mentions[0]
    expect(first?.key).toMatch(/^[a-f0-9]{64}$/)
    expect(second?.key).toBe(first?.key)
    state.comments = [source(201, "Alice", "New source version @sumire-bot")]
    expect((await client.scan()).mentions[0]?.key).not.toBe(first?.key)
  })

  it("skips null bodies and unsubmitted review drafts", async () => {
    const { state, client } = setup()
    state.notifications = [notification("PullRequest")]
    state.hook = (url) => {
      if (url.pathname === `${issuePath}/comments`) return json([{ ...source(), body: null }])
      if (url.pathname === `${pullPath}/reviews`) return json([{ ...source(), submitted_at: null }])
    }
    expect((await client.scan()).mentions).toEqual([])
  })

  it("does not read credentials or use the network when the allowlist is empty", async () => {
    const { state, client, token, fetcher } = setup()
    state.allowed = []
    await expect(client.scan()).rejects.toThrow("allowlist is empty")
    expect(token).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("does not read credentials or use the network when authorization fails", async () => {
    const { state, client, token, fetcher } = setup()
    state.authorized = false
    await expect(client.scan()).rejects.toThrow("configuration revoked")
    expect(token).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each<MentionQuery>([
    { page: 0 },
    { page: 1001 },
    { page: 1.5 },
    { page: Number.NaN },
    { perPage: 0 },
    { perPage: 51 },
    { perPage: 1.5 },
    { perPage: Number.POSITIVE_INFINITY },
    { since: "yesterday" },
    { since: "2026-01-01" },
    { since: "2026-13-01T00:00:00Z" },
    { since: `${timestamp}\n` },
  ])("rejects invalid query %j before credential access", async (query) => {
    const { client, token, fetcher } = setup()
    await expect(client.scan(query)).rejects.toThrow("Invalid GitHub mention query")
    expect(token).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("accepts maximum query bounds without following notification pagination", async () => {
    const { state, client, fetcher } = setup()
    state.notifications = []
    state.notificationHeaders = { link: '<https://hostile.invalid/token>; rel="next"' }
    expect(await client.scan({ page: 1000, perPage: 50 })).toMatchObject({ hasMore: true })
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("page=1000&per_page=50")
  })

  it.each([
    [undefined, 60],
    ["0", 60],
    ["10", 60],
    ["120", 120],
    ["99999", 3600],
    ["garbage", 60],
  ] as const)("bounds the poll interval %s to %s", async (header, expected) => {
    const { state, client } = setup()
    state.notifications = []
    if (header) state.notificationHeaders = { "x-poll-interval": header }
    expect((await client.scan()).pollIntervalSeconds).toBe(expected)
  })

  it.each([
    "https://hostile.invalid/repos/repo-owner/project/issues/12",
    "http://api.github.com/repos/repo-owner/project/issues/12",
    "https://api.github.com@hostile.invalid/repos/repo-owner/project/issues/12",
    "https://api.github.com/repos/other/project/issues/12",
    "https://api.github.com/repos/repo-owner/project/pulls/12",
    "https://api.github.com/repos/repo-owner/project/issues/12?secret=x",
    "https://api.github.com/repos/repo-owner/project/issues/12#fragment",
    "https://api.github.com/repos/repo-owner/project/issues/12\n",
  ])("rejects hostile or mismatched subject URL %s without fetching it", async (url) => {
    const { state, client, fetcher } = setup()
    const row = notification()
    row.subject.url = url
    state.notifications = [row]
    await expect(client.scan()).rejects.toThrow("invalid mention data")
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(
      fetcher.mock.calls.every(
        ([input]) => new URL(String(input)).origin === "https://api.github.com",
      ),
    ).toBe(true)
  })

  it("uses only Link relations and constructs source pagination on the fixed origin", async () => {
    const { state, client, fetcher } = setup()
    state.hook = (url) => {
      if (url.pathname === `${issuePath}/comments`) {
        return url.searchParams.get("page") === "1"
          ? json([source(201)], { link: '<http://127.0.0.1/private?token=x>; rel="next"' })
          : json([source(202)])
      }
    }
    expect((await client.scan()).mentions.map((item) => item.source.id)).toEqual([201, 202])
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toBe(
      `https://api.github.com${issuePath}/comments?per_page=20&page=2`,
    )
  })

  it("fails closed after ten source pages instead of returning a partial scan", async () => {
    const { state, client, fetcher } = setup()
    state.hook = (url) =>
      url.pathname === `${issuePath}/comments`
        ? json([source(201)], { link: '<https://hostile.invalid>; rel="next"' })
        : undefined
    await expect(client.scan()).rejects.toThrow("source pagination limit exceeded")
    expect(fetcher).toHaveBeenCalledTimes(13)
  })

  it("enforces the notification and source array limits", async () => {
    const { state, client } = setup()
    state.notifications = [notification(), notification()]
    await expect(client.scan({ perPage: 1 })).rejects.toThrow("invalid mention data")
    state.notifications = [notification()]
    state.comments = Array.from({ length: 21 }, (_, i) => source(201 + i))
    await expect(client.scan()).rejects.toThrow("invalid mention data")
  })

  it.each([
    { id: 0 },
    { id: Number.MAX_SAFE_INTEGER + 1 },
    { updated_at: "invalid" },
    { body: `@sumire-bot ${"x".repeat(65_536)}` },
    { user: null },
  ])("rejects malformed admitted source %j", async (patch) => {
    const { state, client } = setup()
    state.hook = (url) =>
      url.pathname === `${issuePath}/comments` ? json([{ ...source(), ...patch }]) : undefined
    await expect(client.scan()).rejects.toThrow("invalid mention data")
  })

  it("filters an author revoked while a source request is in flight", async () => {
    const { state, client } = setup()
    state.hook = (url) => {
      if (url.pathname === `${issuePath}/comments`) {
        state.allowed = []
        return json([source()])
      }
    }
    expect((await client.scan()).mentions).toEqual([])
  })

  it("reads PR lists from API endpoints rather than upstream comment URLs", async () => {
    const { state, client, fetcher } = setup()
    state.notifications = [notification("PullRequest")]
    await client.scan()
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/user",
      "/notifications",
      issuePath,
      `${issuePath}/comments`,
      `${pullPath}/comments`,
      `${pullPath}/reviews`,
    ])
  })
})
