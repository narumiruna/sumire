import { describe, expect, it } from "vitest"
import { GithubHttpError } from "../src/api.js"
import {
  account,
  issuePath,
  json,
  notification,
  pullPath,
  repository,
  setup,
  source,
} from "./fixtures.js"

const later = "2026-01-02T00:00:00Z"

describe("body mention identity", () => {
  it.each(["Issue", "PullRequest"])(
    "keeps the %s body key stable across thread activity",
    async (type) => {
      const { state, client } = setup()
      state.notifications = [notification(type)]
      state.issue = source(12)
      const first = (await client.scan()).mentions[0]
      state.issue.updated_at = later
      state.issue.title = "Changed issue title"
      state.comments = [source(202, "other-author", "New thread activity")]
      const next = (await client.scan()).mentions[0]
      expect(first?.source.kind).toBe("issue")
      expect(next?.source.updatedAt).not.toBe(first?.source.updatedAt)
      expect(next?.body).toBe(first?.body)
      expect(next?.key).toBe(first?.key)
      state.issue.body = "@sumire-bot A different request."
      expect((await client.scan()).mentions[0]?.key).not.toBe(first?.key)
    },
  )

  it("finds a body reply marker older than the current issue activity time", async () => {
    const { state, client, mention, fetcher, posts } = setup()
    const original = await mention("issue")
    state.comments = [
      { ...source(901, account.login, `<!-- sumire-mention:${original.key} -->`), user: account },
    ]
    state.issue.updated_at = later
    const rescanned = (await client.scan()).mentions[0]
    if (!rescanned) throw new Error("Missing rescanned body")
    state.hook = (url) => {
      if (url.pathname === `${issuePath}/comments`) {
        const since = url.searchParams.get("since")
        return json(
          state.comments.filter(
            (comment) => !since || Date.parse(comment.updated_at) > Date.parse(since),
          ),
        )
      }
    }
    expect(await client.reply(rescanned, "Must not post again")).toEqual({
      status: "already-replied",
    })
    const markerReads = fetcher.mock.calls.filter(
      ([input]) => new URL(String(input)).pathname === `${issuePath}/comments`,
    )
    expect(new URL(String(markerReads.at(-1)?.[0])).searchParams.has("since")).toBe(false)
    expect(posts).toEqual([])
  })

  it("keeps the existing page bound when checking a body reply marker", async () => {
    const { state, client, mention, posts } = setup()
    const found = await mention("issue")
    state.hook = (url) =>
      url.pathname === `${issuePath}/comments`
        ? json([], { link: '<https://untrusted.invalid>; rel="next"' })
        : undefined
    await expect(client.reply(found, "Do not duplicate")).rejects.toThrow(
      "source pagination limit exceeded",
    )
    expect(posts).toEqual([])
  })

  it("recovers a lost body POST response after that reply changes issue updated_at", async () => {
    const { state, client, mention } = setup()
    const original = await mention("issue")
    let writes = 0
    state.hook = (_url, init) => {
      if (init?.method === "POST") {
        writes++
        const payload = JSON.parse(String(init.body)) as { body: string }
        state.comments.push({ ...source(901, account.login, payload.body), user: account })
        state.issue.updated_at = later
        throw new Error("Synthetic response lost after the write")
      }
    }
    await expect(client.reply(original, "Saved answer")).rejects.toThrow(
      "request failed or timed out",
    )
    const rescanned = (await client.scan()).mentions[0]
    if (!rescanned) throw new Error("Missing rescanned body")
    expect(rescanned.key).toBe(original.key)
    expect(await client.reply(original, "Saved answer")).toEqual({ status: "already-replied" })
    expect(await client.reply(rescanned, "Saved answer")).toEqual({ status: "already-replied" })
    expect(writes).toBe(1)
  })

  it("still rejects a stale answer after a real body edit", async () => {
    const { state, client, mention, posts } = setup()
    const original = await mention("issue")
    state.issue.body = "@sumire-bot New request."
    state.issue.updated_at = later
    expect(await client.reply(original, "Old answer")).toEqual({ status: "ignored" })
    expect(posts).toEqual([])
    const current = (await client.scan()).mentions[0]
    if (!current) throw new Error("Missing edited body")
    expect(current.key).not.toBe(original.key)
    expect(await client.reply(current, "New answer")).toEqual({ status: "sent" })
    expect(posts).toHaveLength(1)
  })
})

describe("unavailable mention sources", () => {
  it.each([404, 410])(
    "skips a missing issue with HTTP %s without losing a later thread",
    async (status) => {
      const { state, client } = setup()
      const next = notification("Issue", "mention", "thread-2")
      next.subject.url = `https://api.github.com/repos/${repository}/issues/13`
      state.notifications.push(next)
      state.hook = (url) => {
        if (url.pathname === issuePath) return new Response("Private upstream body", { status })
        if (url.pathname === `/repos/${repository}/issues/13`) return json(source(13))
        if (url.pathname === `/repos/${repository}/issues/13/comments`) return json([])
      }
      expect((await client.scan()).mentions.map((item) => item.source.id)).toEqual([13])
    },
  )

  for (const kind of ["issue", "issue-comment", "review-comment", "review"] as const) {
    it.each([404, 410])(
      "ignores a missing " + kind + " source with HTTP %s without a POST",
      async (status) => {
        const { state, client, mention, posts } = setup()
        const found = await mention(kind)
        const sourcePath =
          kind === "issue"
            ? issuePath
            : kind === "issue-comment"
              ? `/repos/${repository}/issues/comments/201`
              : kind === "review-comment"
                ? `/repos/${repository}/pulls/comments/201`
                : `${pullPath}/reviews/201`
        state.hook = (url) =>
          url.pathname === sourcePath
            ? new Response("Private upstream body", { status })
            : undefined
        expect(await client.reply(found, "No response")).toEqual({ status: "ignored" })
        expect(posts).toEqual([])
      },
    )
  }

  it.each([401, 403, 429, 500])(
    "keeps HTTP %s source errors structured and retryable",
    async (status) => {
      const { state, client, mention, posts } = setup()
      const found = await mention()
      state.hook = (url) =>
        url.pathname === `/repos/${repository}/issues/comments/201`
          ? new Response("Private upstream body", { status })
          : undefined
      const error = await client.reply(found, "Keep pending").catch((error: unknown) => error)
      expect(error).toBeInstanceOf(GithubHttpError)
      expect(error).toMatchObject({
        status,
        message: `GitHub mention request failed (HTTP ${status})`,
      })
      expect(posts).toEqual([])
    },
  )

  it.each(["account", "markers", "post"])(
    "does not ignore HTTP 404 from %s requests",
    async (stage) => {
      const { state, client, mention, posts } = setup()
      const found = await mention()
      state.hook = (url, init) => {
        if (
          (stage === "account" && url.pathname === "/user") ||
          (stage === "markers" && url.pathname === `${issuePath}/comments`) ||
          (stage === "post" && init?.method === "POST")
        )
          return new Response("Private upstream body", { status: 404 })
      }
      await expect(client.reply(found, "Keep pending")).rejects.toMatchObject({ status: 404 })
      expect(posts).toEqual([])
    },
  )

  it.each(["authorization", "token", "abort"])(
    "preserves %s failure when a source returns 404",
    async (change) => {
      const { state, client, mention, posts } = setup()
      const found = await mention()
      const abort = new AbortController()
      state.hook = (url) => {
        if (url.pathname !== `/repos/${repository}/issues/comments/201`) return
        if (change === "authorization") state.authorized = false
        if (change === "token") state.credential = "replacement-synthetic-token"
        if (change === "abort") abort.abort(new Error("Cancelled operation"))
        return new Response("Private upstream body", { status: 404 })
      }
      await expect(client.reply(found, "No response", abort.signal)).rejects.toThrow(
        change === "authorization"
          ? "configuration revoked"
          : change === "token"
            ? "credentials changed"
            : "Cancelled operation",
      )
      expect(posts).toEqual([])
    },
  )
})
