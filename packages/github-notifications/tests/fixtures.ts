import { vi } from "vitest"
import { createGithubMentionClient, type GithubMention } from "../src/index.js"

export const tokenValue = "synthetic-github-token"
export const timestamp = "2026-01-01T00:00:00Z"
export const repository = "repo-owner/project"
export const issuePath = `/repos/${repository}/issues/12`
export const pullPath = `/repos/${repository}/pulls/12`
export const account = { id: 101, login: "sumire-bot" }

export function source(id = 201, author = "Alice", body = "Please check @sumire-bot.") {
  return {
    id,
    user: { id: id + 1000, login: author },
    body,
    title: "Source title",
    updated_at: timestamp,
    submitted_at: timestamp,
    issue_url: `https://api.github.com${issuePath}`,
    pull_request_url: `https://api.github.com${pullPath}`,
    html_url: "https://untrusted.invalid/do-not-follow",
    secret_extra: "untrusted-extra-field",
  }
}
export type Source = ReturnType<typeof source> & { in_reply_to_id?: number }
export function notification(type = "Issue", reason = "mention", id = "thread-1") {
  return {
    id,
    reason,
    repository: { full_name: repository, owner: { login: "repo-owner" } },
    actor: { login: "unapproved-latest-actor" },
    subject: {
      type,
      title: "Untrusted notification title",
      url: `https://api.github.com/repos/${repository}/${type === "PullRequest" ? "pulls" : "issues"}/12`,
      latest_comment_url: "https://untrusted.invalid/latest",
    },
  }
}
export function json(data: unknown, headers?: ConstructorParameters<typeof Headers>[0]) {
  return new Response(JSON.stringify(data), { headers })
}

export function setup() {
  const state = {
    account: { ...account },
    allowed: ["alice"],
    credential: tokenValue as string | undefined,
    authorized: true,
    notifications: [notification()],
    issue: source(12, "repo-owner", "Issue without a mention"),
    comments: [] as Source[],
    reviewComments: [] as Source[],
    reviews: [] as Source[],
    notificationHeaders: {} as Record<string, string>,
    hook: undefined as
      | ((
          url: URL,
          init: RequestInit | undefined,
        ) => Response | undefined | Promise<Response | undefined>)
      | undefined,
  }
  const authorize = vi.fn(() => {
    if (!state.authorized) throw new Error("configuration revoked")
  })
  const token = vi.fn(() => state.credential)
  const allowedUsernames = vi.fn(() => state.allowed)
  const posts: { path: string; body: { body: string } }[] = []
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    if (url.origin !== "https://api.github.com") throw new Error("Unexpected fetch origin")
    const overridden = await state.hook?.(url, init)
    if (overridden) return overridden
    const path = url.pathname
    if (init?.method === "POST") {
      posts.push({ path, body: JSON.parse(String(init.body)) })
      return json({ id: 900 })
    }
    if (path === "/user") return json(state.account)
    if (path === "/notifications") return json(state.notifications, state.notificationHeaders)
    if (path === issuePath) return json(state.issue)
    if (path === `${issuePath}/comments`) return json(state.comments)
    if (path === `${pullPath}/comments`) return json(state.reviewComments)
    if (path === `${pullPath}/reviews`) return json(state.reviews)
    const comment =
      state.comments.find((item) => path === `/repos/${repository}/issues/comments/${item.id}`) ??
      state.reviewComments.find(
        (item) => path === `/repos/${repository}/pulls/comments/${item.id}`,
      ) ??
      state.reviews.find((item) => path === `${pullPath}/reviews/${item.id}`)
    if (comment) return json(comment)
    throw new Error(`Unexpected test request: ${path}`)
  })
  const options = { authorize, token, allowedUsernames, fetch: fetcher }
  const client = createGithubMentionClient(options)
  async function mention(kind: GithubMention["source"]["kind"] = "issue-comment") {
    state.notifications = [
      notification(kind === "review" || kind === "review-comment" ? "PullRequest" : "Issue"),
    ]
    const record = source()
    if (kind === "issue") state.issue = source(12)
    else if (kind === "issue-comment") state.comments = [record]
    else if (kind === "review-comment") state.reviewComments = [record]
    else state.reviews = [record]
    const result = (await client.scan()).mentions.find((item) => item.source.kind === kind)
    if (!result) throw new Error(`Missing fixture mention: ${kind}`)
    fetcher.mockClear()
    posts.length = 0
    return result
  }
  return { state, authorize, token, allowedUsernames, fetcher, posts, options, client, mention }
}
