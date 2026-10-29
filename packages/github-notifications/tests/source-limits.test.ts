import { describe, expect, it } from "vitest"
import { issuePath, json, notification, pullPath, setup, source, timestamp } from "./fixtures.js"

const otherRepository = "other/project"
const otherIssuePath = `/repos/${otherRepository}/issues/13`
const histories = [
  ["issue comments", `${issuePath}/comments`],
  ["review comments", `${pullPath}/comments`],
  ["reviews", `${pullPath}/reviews`],
] as const

function fixture() {
  const f = setup()
  const next = notification("Issue", "mention", "later-thread")
  next.repository.full_name = otherRepository
  next.subject.url = `https://api.github.com${otherIssuePath}`
  f.state.notifications = [notification("PullRequest"), next]
  // All of these sources must be discarded if any one history exceeds its bound.
  f.state.issue = source(12)
  f.state.comments = [source(201)]
  f.state.reviewComments = [source(301)]
  f.state.reviews = [source(401)]
  const later = (url: URL) => {
    if (url.pathname === otherIssuePath) return json(source(13))
    if (url.pathname === `${otherIssuePath}/comments`) return json([])
  }
  return { ...f, later }
}

describe("source history isolation", () => {
  it.each(histories)(
    "discards oversized %s without blocking another repository on repeated scans",
    async (_name, path) => {
      const f = fixture()
      f.state.hook = (url) => {
        if (url.pathname === path) {
          const page = Number(url.searchParams.get("page"))
          const rows = Array.from({ length: 20 }, (_, index) => ({
            ...source(page * 20 + index, "alice", "Private historical body @sumire-bot"),
            updated_at: "2020-01-01T00:00:00Z",
            submitted_at: "2020-01-01T00:00:00Z",
          }))
          if (path === `${pullPath}/reviews`) expect(url.searchParams.has("since")).toBe(false)
          return json(rows, { link: '<https://untrusted.invalid/private>; rel="next"' })
        }
        return f.later(url)
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await f.client.scan({ since: timestamp })
        expect(result.skippedThreads).toBe(1)
        expect(result.mentions.map((mention) => [mention.repository, mention.source.id])).toEqual([
          [otherRepository, 13],
        ])
        expect(JSON.stringify(result)).not.toContain("Private historical body")
      }
      expect(
        f.fetcher.mock.calls
          .map(([input]) => new URL(String(input)))
          .filter((url) => url.pathname === path)
          .map((url) => Number(url.searchParams.get("page"))),
      ).toEqual([
        ...Array.from({ length: 10 }, (_, i) => i + 1),
        ...Array.from({ length: 10 }, (_, i) => i + 1),
      ])
      expect(
        f.fetcher.mock.calls.filter(
          ([input]) => new URL(String(input)).pathname === otherIssuePath,
        ),
      ).toHaveLength(2)
      expect(f.posts).toEqual([])
    },
  )

  it.each(histories)("accepts a complete ten-page %s history", async (_name, path) => {
    const f = fixture()
    f.state.hook = (url) => {
      if (url.pathname === path) {
        const page = Number(url.searchParams.get("page"))
        return json(
          Array.from({ length: 20 }, (_, index) => source(1000 + page * 20 + index)),
          page < 10 ? { link: '<https://untrusted.invalid>; rel="next"' } : undefined,
        )
      }
      return f.later(url)
    }
    const result = await f.client.scan({ since: timestamp })
    expect(result.skippedThreads).toBe(0)
    expect(
      result.mentions.filter((mention) => mention.repository !== otherRepository),
    ).toHaveLength(203)
    expect(result.mentions.some((mention) => mention.repository === otherRepository)).toBe(true)
  })

  it("reports zero skipped threads for an empty notification page", async () => {
    const f = setup()
    f.state.notifications = []
    expect(await f.client.scan()).toMatchObject({ mentions: [], skippedThreads: 0 })
  })

  it.each(["authorization", "token", "abort"])(
    "preserves %s failure at the source page limit",
    async (change) => {
      const f = fixture()
      const controller = new AbortController()
      f.state.hook = (url) => {
        if (url.pathname === `${pullPath}/reviews`) {
          if (url.searchParams.get("page") === "10") {
            if (change === "authorization") f.state.authorized = false
            if (change === "token") f.state.credential = "different-synthetic-token"
            if (change === "abort") controller.abort(new Error("Cancelled synthetic scan"))
          }
          return json([], { link: '<https://untrusted.invalid>; rel="next"' })
        }
        return f.later(url)
      }
      await expect(f.client.scan({ since: timestamp }, controller.signal)).rejects.toThrow(
        change === "authorization"
          ? "configuration revoked"
          : change === "token"
            ? "credentials changed"
            : "Cancelled synthetic scan",
      )
      expect(
        f.fetcher.mock.calls.some(([input]) => new URL(String(input)).pathname === otherIssuePath),
      ).toBe(false)
    },
  )

  it.each(["http", "transport", "invalid-json", "bytes"])(
    "does not skip a thread for a %s source failure",
    async (failure) => {
      const f = fixture()
      f.state.hook = (url) => {
        if (url.pathname === `${pullPath}/reviews`) {
          if (failure === "http") return new Response("Private upstream body", { status: 500 })
          // Matching message text is not a typed source pagination failure.
          if (failure === "transport")
            throw new Error("GitHub mention source pagination limit exceeded")
          if (failure === "invalid-json") return new Response("not JSON")
          return new Response("[]", { headers: { "content-length": String(2 * 1024 * 1024 + 1) } })
        }
        return f.later(url)
      }
      await expect(f.client.scan({ since: timestamp })).rejects.toThrow(
        failure === "http"
          ? "HTTP 500"
          : failure === "transport"
            ? "failed or timed out"
            : failure === "invalid-json"
              ? "invalid mention data"
              : "size limit",
      )
      expect(
        f.fetcher.mock.calls.some(([input]) => new URL(String(input)).pathname === otherIssuePath),
      ).toBe(false)
      expect(f.posts).toEqual([])
    },
  )
})
