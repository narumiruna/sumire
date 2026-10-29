import { describe, expect, it } from "vitest"
import type { GithubMention } from "../src/index.js"
import {
  account,
  issuePath,
  json,
  pullPath,
  repository,
  setup,
  source,
  timestamp,
} from "./fixtures.js"

const kinds = ["issue", "issue-comment", "review-comment", "review"] as const

describe("mention replies", () => {
  it.each(kinds)("rechecks the %s source and posts the hidden source-key marker", async (kind) => {
    const { state, client, mention, fetcher, posts } = setup()
    const found = await mention(kind)
    expect(await client.reply(found, "Checked this.")).toEqual({ status: "sent" })
    const sourcePath =
      kind === "issue"
        ? issuePath
        : kind === "issue-comment"
          ? `/repos/${repository}/issues/comments/201`
          : kind === "review-comment"
            ? `/repos/${repository}/pulls/comments/201`
            : `${pullPath}/reviews/201`
    const commentsPath =
      kind === "review-comment" ? `${pullPath}/comments` : `${issuePath}/comments`
    const target =
      kind === "review-comment" ? `${pullPath}/comments/201/replies` : `${issuePath}/comments`
    expect(fetcher.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/user",
      sourcePath,
      commentsPath,
      "/user",
      target,
    ])
    expect(new URL(String(fetcher.mock.calls[2]?.[0])).searchParams.get("since")).toBe(
      kind === "issue" ? null : timestamp,
    )
    expect(posts).toEqual([
      { path: target, body: { body: `Checked this.\n\n<!-- sumire-mention:${found.key} -->` } },
    ])
    expect(fetcher.mock.calls.at(-1)?.[1]).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
    })
    expect(state.allowed).toEqual(["alice"])
  })

  it("replies to the root inline review thread rather than to a child reply", async () => {
    const { state, client, mention, posts } = setup()
    const found = await mention("review-comment")
    state.reviewComments = [{ ...source(), in_reply_to_id: 177 }]
    expect(await client.reply(found, "Thread response")).toEqual({ status: "sent" })
    expect(posts[0]?.path).toBe(`${pullPath}/comments/177/replies`)
  })

  it.each(kinds)("recognizes an existing bot marker for %s without a POST", async (kind) => {
    const { state, client, mention, posts } = setup()
    const found = await mention(kind)
    const duplicate = {
      ...source(901, account.login, `Prior reply\n\n<!-- sumire-mention:${found.key} -->`),
      user: account,
    }
    if (kind === "review-comment") state.reviewComments.push(duplicate)
    else state.comments.push(duplicate)
    expect(await client.reply(found, "Do not duplicate")).toEqual({ status: "already-replied" })
    expect(posts).toEqual([])
  })

  it("does not trust another user's marker or a marker for a different source", async () => {
    const { state, client, mention, posts } = setup()
    const found = await mention()
    state.comments.push(source(901, "mallory", `<!-- sumire-mention:${found.key} -->`))
    state.comments.push({
      ...source(902, account.login, `<!-- sumire-mention:${"0".repeat(64)} -->`),
      user: account,
    })
    expect(await client.reply(found, "Reply")).toEqual({ status: "sent" })
    expect(posts).toHaveLength(1)
  })

  it("checks all duplicate pages and keeps the endpoint on the fixed origin", async () => {
    const { state, client, mention, fetcher, posts } = setup()
    const found = await mention()
    state.hook = (url) => {
      if (url.pathname === `${issuePath}/comments`)
        return url.searchParams.get("page") === "1"
          ? json([], { link: '<https://hostile.invalid/private>; rel="next"' })
          : json([{ id: 901, user: account, body: `<!-- sumire-mention:${found.key} -->` }])
    }
    expect(await client.reply(found, "Reply")).toEqual({ status: "already-replied" })
    expect(String(fetcher.mock.calls.at(-1)?.[0])).toBe(
      `https://api.github.com${issuePath}/comments?per_page=20&page=2&since=${encodeURIComponent(timestamp)}`,
    )
    expect(posts).toEqual([])
  })

  it("does not write when duplicate discovery exceeds its page bound", async () => {
    const { state, client, mention, fetcher, posts } = setup()
    const found = await mention()
    state.hook = (url) =>
      url.pathname === `${issuePath}/comments`
        ? json([], { link: '<https://hostile.invalid>; rel="next"' })
        : undefined
    await expect(client.reply(found, "Reply")).rejects.toThrow("source pagination limit exceeded")
    expect(fetcher).toHaveBeenCalledTimes(12)
    expect(posts).toEqual([])
  })

  it("recovers an uncertain POST by finding its marker on retry", async () => {
    const { state, client, mention, fetcher, posts } = setup()
    const found = await mention()
    let writes = 0
    state.hook = (_url, init) => {
      if (init?.method === "POST") {
        writes++
        const body = JSON.parse(String(init.body)) as { body: string }
        state.comments.push({ ...source(901, account.login, body.body), user: account })
        throw new Error("synthetic-token private response lost after write")
      }
    }
    await expect(client.reply(found, "Reply")).rejects.toThrow(
      "GitHub mention request failed or timed out",
    )
    expect(writes).toBe(1)
    expect(await client.reply(found, "Reply")).toEqual({ status: "already-replied" })
    expect(writes).toBe(1)
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1)
    expect(posts).toEqual([])
  })

  it("does not access credentials or the network for a denied author", async () => {
    const { state, client, mention, token, fetcher, posts } = setup()
    const found = await mention()
    token.mockClear()
    state.allowed = []
    expect(await client.reply(found, "Reply")).toEqual({ status: "ignored" })
    expect(token).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    expect(posts).toEqual([])
  })

  it("checks current host authorization before credentials or requests", async () => {
    const { state, client, mention, token, fetcher } = setup()
    const found = await mention()
    token.mockClear()
    state.authorized = false
    await expect(client.reply(found, "Reply")).rejects.toThrow("configuration revoked")
    expect(token).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    { id: 102, login: account.login },
    { id: account.id, login: "other-bot" },
  ])("ignores a changed authenticated account %j before reading the source", async (current) => {
    const { state, client, mention, fetcher, posts } = setup()
    const found = await mention()
    state.account = current
    expect(await client.reply(found, "Reply")).toEqual({ status: "ignored" })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(posts).toEqual([])
  })

  it("treats account login casing as the same account", async () => {
    const { state, client, mention } = setup()
    const found = await mention()
    state.account.login = "SUMIRE-BOT"
    expect(await client.reply(found, "Reply")).toEqual({ status: "sent" })
  })

  it.each(["body", "timestamp", "author", "self", "id"])(
    "ignores a source whose %s changed",
    async (field) => {
      const { state, client, mention, posts } = setup()
      const found = await mention()
      const current = state.comments[0]
      if (!current) throw new Error("Missing fixture source")
      if (field === "body") current.body = "Changed text @sumire-bot"
      else if (field === "timestamp") current.updated_at = "2026-01-02T00:00:00Z"
      else if (field === "author") current.user.login = "mallory"
      else if (field === "self") current.user.login = account.login
      else
        state.hook = (url) =>
          url.pathname === `/repos/${repository}/issues/comments/201`
            ? json({ ...current, id: 202 })
            : undefined
      expect(await client.reply(found, "Reply")).toEqual({ status: "ignored" })
      expect(posts).toEqual([])
    },
  )

  it.each(["issue-comment", "review-comment"] as const)(
    "rejects a %s source from another issue/PR",
    async (kind) => {
      const { state, client, mention, posts } = setup()
      const found = await mention(kind)
      const current = (kind === "issue-comment" ? state.comments : state.reviewComments)[0]
      if (!current) throw new Error("Missing fixture source")
      current.issue_url = "https://api.github.com/repos/other/project/issues/12"
      current.pull_request_url = "https://api.github.com/repos/other/project/pulls/12"
      await expect(client.reply(found, "Reply")).rejects.toThrow("invalid mention data")
      expect(posts).toEqual([])
    },
  )

  it.each(["source", "duplicates", "final-account"])(
    "ignores admission revoked during %s HTTP",
    async (stage) => {
      const { state, client, mention, posts } = setup()
      const found = await mention()
      let users = 0
      state.hook = (url) => {
        if (url.pathname === "/user") users++
        if (
          (stage === "source" && url.pathname === `/repos/${repository}/issues/comments/201`) ||
          (stage === "duplicates" && url.pathname === `${issuePath}/comments`) ||
          (stage === "final-account" && url.pathname === "/user" && users === 2)
        )
          state.allowed = []
      }
      expect(await client.reply(found, "Reply")).toEqual({ status: "ignored" })
      expect(posts).toEqual([])
    },
  )

  it("ignores a changed source author even when both usernames are allowed", async () => {
    const { state, client, mention, posts } = setup()
    const found = await mention()
    state.allowed = ["alice", "bob"]
    state.comments = [source(201, "Bob")]
    expect(await client.reply(found, "Reply")).toEqual({ status: "ignored" })
    expect(posts).toEqual([])
  })

  it("ignores a source edited while its HTTP request is in flight", async () => {
    const { state, client, mention, posts } = setup()
    const found = await mention()
    state.hook = (url) =>
      url.pathname === `/repos/${repository}/issues/comments/201`
        ? json(source(201, "Alice", "Edited source @sumire-bot"))
        : undefined
    expect(await client.reply(found, "Reply")).toEqual({ status: "ignored" })
    expect(posts).toEqual([])
  })

  it("rechecks account identity at the last account HTTP response before posting", async () => {
    const { state, client, mention, posts } = setup()
    const found = await mention()
    let users = 0
    state.hook = (url) => {
      if (url.pathname === "/user" && ++users === 2) return json({ id: 102, login: "other-bot" })
    }
    expect(await client.reply(found, "Reply")).toEqual({ status: "ignored" })
    expect(posts).toEqual([])
  })

  it.each(["source", "duplicates", "final-account"])(
    "rejects a token changed during %s HTTP without a POST",
    async (stage) => {
      const { state, client, mention, posts } = setup()
      const found = await mention()
      let users = 0
      state.hook = (url) => {
        if (url.pathname === "/user") users++
        if (
          (stage === "source" && url.pathname === `/repos/${repository}/issues/comments/201`) ||
          (stage === "duplicates" && url.pathname === `${issuePath}/comments`) ||
          (stage === "final-account" && url.pathname === "/user" && users === 2)
        )
          state.credential = "replacement-synthetic-token"
      }
      await expect(client.reply(found, "Reply")).rejects.toThrow("GitHub credentials changed")
      expect(posts).toEqual([])
    },
  )

  it("rejects host revocation during duplicate discovery without a POST", async () => {
    const { state, client, mention, posts } = setup()
    const found = await mention()
    state.hook = (url) => {
      if (url.pathname === `${issuePath}/comments`) state.authorized = false
    }
    await expect(client.reply(found, "Reply")).rejects.toThrow("configuration revoked")
    expect(posts).toEqual([])
  })

  it.each(["", "   ", "a".repeat(60_001), "界".repeat(20_001)])(
    "rejects an empty or oversized reply before any request",
    async (reply) => {
      const { client, mention, fetcher } = setup()
      const found = await mention()
      await expect(client.reply(found, reply)).rejects.toThrow("1–60,000 UTF-8 bytes")
      expect(fetcher).not.toHaveBeenCalled()
    },
  )

  it("accepts a 60,000-byte reply", async () => {
    const { client, mention } = setup()
    const found = await mention()
    expect(await client.reply(found, "界".repeat(20_000))).toEqual({ status: "sent" })
  })

  it.each([
    { key: "not-a-key" },
    { key: `${"a".repeat(64)}\n` },
    { repository: "repo-owner/project\n" },
    { repository: "../secret" },
    { repository: "repo-owner/../secret" },
    { issueNumber: 0 },
    { issueNumber: 1.5 },
    { account: { id: 0, login: account.login } },
    { source: { kind: "other", id: 201, updatedAt: timestamp } },
    { source: { kind: "issue-comment", id: 0, updatedAt: timestamp } },
    { source: { kind: "issue-comment", id: 201, updatedAt: "invalid" } },
  ])("rejects an invalid reply target %j before any request", async (patch) => {
    const { client, mention, fetcher } = setup()
    const found = await mention()
    await expect(client.reply({ ...found, ...patch } as GithubMention, "Reply")).rejects.toThrow(
      "invalid mention data",
    )
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("preserves caller cancellation during duplicate discovery without a POST", async () => {
    const { state, client, mention, posts } = setup()
    const found = await mention()
    const abort = new AbortController()
    state.hook = (url) => {
      if (url.pathname === `${issuePath}/comments`) abort.abort(new Error("cancel reply"))
    }
    await expect(client.reply(found, "Reply", abort.signal)).rejects.toThrow("cancel reply")
    expect(posts).toEqual([])
  })
})
