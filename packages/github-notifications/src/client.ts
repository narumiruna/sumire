import { createHash } from "node:crypto"
import { GithubHttpError, type GithubMentionClientOptions, invalid, openApi } from "./api.js"
import { allowsMentionAuthor, mentionsAccount } from "./config.js"

export interface GithubAccount {
  id: number
  login: string
}
export interface GithubMention {
  key: string
  account: GithubAccount
  author: string
  repository: string
  issueNumber: number
  title: string
  body: string
  url: string
  source: {
    kind: "issue" | "issue-comment" | "review-comment" | "review"
    id: number
    updatedAt: string
  }
  threadId: string
}
export interface MentionQuery {
  since?: string
  page?: number
  perPage?: number
}
export interface MentionPage {
  account: GithubAccount
  mentions: GithubMention[]
  hasMore: boolean
  pageKey: string
  pollIntervalSeconds: number
}
type Api = ReturnType<typeof openApi>
type Thread = {
  id: string
  repository: string
  number: number
  pull: boolean
  title: string
}
const listSize = 20
const maxPages = 10
const minimumPollSeconds = 60
const username = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}(?![\s\S])/i

/** GitHub owns event identity; neither a model nor a Telegram identity selects the author or target. */
export function createGithubMentionClient(options: GithubMentionClientOptions) {
  const allowed = (author: string) => allowsMentionAuthor(author, options.allowedUsernames())
  return {
    async scan(query: MentionQuery = {}, signal?: AbortSignal): Promise<MentionPage> {
      options.authorize()
      const page = query.page ?? 1
      const perPage = query.perPage ?? 20
      if (
        !Number.isInteger(page) ||
        page < 1 ||
        page > 1000 ||
        !Number.isInteger(perPage) ||
        perPage < 1 ||
        perPage > 50 ||
        (query.since !== undefined && !isTimestamp(query.since))
      )
        throw new Error("Invalid GitHub mention query")
      if (options.allowedUsernames().length === 0)
        throw new Error("GitHub mention allowlist is empty")
      const api = openApi(options, signal)
      const account = await readAccount(api)
      const params = new URLSearchParams({
        all: "true",
        page: String(page),
        per_page: String(perPage),
      })
      if (query.since) params.set("since", query.since)
      const response = await api.request(`/notifications?${params}`)
      const rows = array(response.data, perPage)
      const found = new Map<string, GithubMention>()
      const seenThreads = new Set<string>()
      for (const value of rows) {
        const notification = object(value)
        // Subscription, assignment, team, and review-request notifications are not direct mentions.
        if (notification.reason !== "mention") continue
        const thread = notificationThread(notification)
        if (!thread || seenThreads.has(`${thread.repository}/${thread.number}`)) continue
        seenThreads.add(`${thread.repository}/${thread.number}`)
        const base = `/repos/${thread.repository}`
        const issue = await readSource(api, `${base}/issues/${thread.number}`)
        if (!issue) continue
        thread.title = text(issue.title, 2048)
        const records: { kind: GithubMention["source"]["kind"]; value: unknown }[] = [
          { kind: "issue", value: issue },
        ]
        for (const value of await list(
          api,
          `${base}/issues/${thread.number}/comments`,
          query.since,
        ))
          records.push({ kind: "issue-comment", value })
        if (thread.pull) {
          for (const value of await list(
            api,
            `${base}/pulls/${thread.number}/comments`,
            query.since,
          ))
            records.push({ kind: "review-comment", value })
          for (const value of await list(api, `${base}/pulls/${thread.number}/reviews`))
            records.push({ kind: "review", value })
        }
        for (const record of records) {
          const mention = normalizeMention(
            record.value,
            record.kind,
            thread,
            account,
            allowed,
            query.since,
          )
          if (mention) found.set(mention.key, mention)
        }
      }
      api.assert()
      const mentions = [...found.values()].filter((mention) => allowed(mention.author))
      return {
        account,
        mentions,
        hasMore: hasNext(response.headers),
        pageKey: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
        pollIntervalSeconds: Math.min(
          3600,
          Math.max(
            minimumPollSeconds,
            Number(response.headers.get("x-poll-interval")) || minimumPollSeconds,
          ),
        ),
      }
    },

    async reply(
      mention: GithubMention,
      reply: string,
      signal?: AbortSignal,
    ): Promise<{ status: "sent" | "already-replied" | "ignored" }> {
      options.authorize()
      if (!allowed(mention.author)) return { status: "ignored" }
      validateMention(mention)
      if (typeof reply !== "string" || !reply.trim() || Buffer.byteLength(reply, "utf8") > 60_000)
        throw new Error("GitHub reply must contain 1–60,000 UTF-8 bytes")
      const api = openApi(options, signal)
      const account = await readAccount(api)
      if (!sameAccount(account, mention.account)) return { status: "ignored" }
      const base = `/repos/${mention.repository}`
      const issuePath = `${base}/issues/${mention.issueNumber}`
      const pullPath = `${base}/pulls/${mention.issueNumber}`
      const sourcePath =
        mention.source.kind === "issue"
          ? issuePath
          : mention.source.kind === "issue-comment"
            ? `${base}/issues/comments/${mention.source.id}`
            : mention.source.kind === "review-comment"
              ? `${base}/pulls/comments/${mention.source.id}`
              : `${pullPath}/reviews/${mention.source.id}`
      const source = await readSource(api, sourcePath)
      if (!source) return { status: "ignored" }
      if (
        (mention.source.kind === "issue-comment" &&
          source.issue_url !== `https://api.github.com${issuePath}`) ||
        (mention.source.kind === "review-comment" &&
          source.pull_request_url !== `https://api.github.com${pullPath}`)
      )
        throw invalid()
      const fresh = normalizeMention(
        source,
        mention.source.kind,
        {
          id: mention.threadId,
          repository: mention.repository,
          number: mention.issueNumber,
          title: mention.title,
          pull: mention.source.kind === "review" || mention.source.kind === "review-comment",
        },
        account,
        allowed,
      )
      if (!fresh || fresh.key !== mention.key) return { status: "ignored" }
      const marker = `<!-- sumire-mention:${mention.key} -->`
      const commentsPath =
        mention.source.kind === "review-comment" ? `${pullPath}/comments` : `${issuePath}/comments`
      // An issue update can occur after a body reply. Keep its marker in the search.
      const comments = await list(
        api,
        commentsPath,
        mention.source.kind === "issue" ? undefined : mention.source.updatedAt,
      )
      for (const value of comments) {
        const comment = object(value)
        const user = object(comment.user)
        if (
          user.id === account.id &&
          typeof comment.body === "string" &&
          comment.body.includes(marker)
        )
          return { status: "already-replied" }
      }
      if (!allowed(fresh.author)) return { status: "ignored" }
      const verifiedAccount = await readAccount(api)
      if (!sameAccount(verifiedAccount, mention.account)) return { status: "ignored" }
      const target =
        mention.source.kind === "review-comment"
          ? `${pullPath}/comments/${positiveId(source.in_reply_to_id ?? source.id)}/replies`
          : `${issuePath}/comments`
      // Author admission is checked at the last synchronous boundary before the write.
      if (!allowed(fresh.author)) return { status: "ignored" }
      await api.request(target, { body: `${reply}\n\n${marker}` })
      return { status: "sent" }
    },
  }
}

async function readSource(api: Api, path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return object((await api.request(path)).data)
  } catch (error) {
    if (error instanceof GithubHttpError && (error.status === 404 || error.status === 410)) {
      api.assert()
      return undefined
    }
    throw error
  }
}

async function readAccount(api: Api): Promise<GithubAccount> {
  const user = object((await api.request("/user")).data)
  const login = text(user.login, 39)
  if (!username.test(login)) throw invalid()
  return { id: positiveId(user.id), login }
}
function sameAccount(a: GithubAccount, b: GithubAccount) {
  return a.id === b.id && a.login.toLowerCase() === b.login.toLowerCase()
}
async function list(api: Api, path: string, since?: string): Promise<unknown[]> {
  const result: unknown[] = []
  for (let page = 1; page <= maxPages; page++) {
    const query = new URLSearchParams({ per_page: String(listSize), page: String(page) })
    if (since) query.set("since", since)
    const response = await api.request(`${path}?${query}`)
    result.push(...array(response.data, listSize))
    if (!hasNext(response.headers)) return result
  }
  // Never return partial source data or claim a duplicate is absent after a truncated scan.
  throw new Error("GitHub mention source pagination limit exceeded")
}
function hasNext(headers: Headers): boolean {
  // Only the relation is used. Upstream URLs never select a request destination.
  return /(?:^|,)\s*<[^>]*>;\s*rel="next"(?:\s*(?:,|$))/.test(headers.get("link") ?? "")
}
function notificationThread(notification: Record<string, unknown>): Thread | undefined {
  const subject = object(notification.subject)
  if (subject.type !== "Issue" && subject.type !== "PullRequest") return undefined
  const repository = text(object(notification.repository).full_name, 140)
  if (!validRepository(repository)) throw invalid()
  const match =
    /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(issues|pulls)\/([1-9]\d*)(?![\s\S])/.exec(
      text(subject.url, 512),
    )
  if (
    !match ||
    match[1]?.toLowerCase() !== repository.toLowerCase() ||
    match[2] !== (subject.type === "Issue" ? "issues" : "pulls")
  )
    throw invalid()
  return {
    id: text(notification.id, 128),
    repository,
    number: positiveId(Number(match[3])),
    pull: subject.type === "PullRequest",
    title: "",
  }
}
function normalizeMention(
  value: unknown,
  kind: GithubMention["source"]["kind"],
  thread: Thread,
  account: GithubAccount,
  allowed: (author: string) => boolean,
  since?: string,
): GithubMention | undefined {
  const source = object(value)
  const author = text(object(source.user).login, 100)
  // No unapproved source body is returned to the model. Bot comments cannot trigger a loop.
  if (!allowed(author) || author.toLowerCase() === account.login.toLowerCase()) return undefined
  const body = source.body === null ? "" : text(source.body, 65_536)
  if (!mentionsAccount(body, account.login)) return undefined
  const updatedAt = kind === "review" ? source.submitted_at : source.updated_at
  if (kind === "review" && updatedAt === null) return undefined
  if (!isTimestamp(updatedAt)) throw invalid()
  if (since && Date.parse(updatedAt) < Date.parse(since)) return undefined
  const sourceId = positiveId(source.id)
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        account.id,
        thread.repository.toLowerCase(),
        thread.number,
        kind,
        sourceId,
        kind === "issue" ? null : updatedAt,
        body,
        author.toLowerCase(),
      ]),
    )
    .digest("hex")
  const anchor =
    kind === "issue"
      ? ""
      : kind === "issue-comment"
        ? `#issuecomment-${sourceId}`
        : kind === "review-comment"
          ? `#discussion_r${sourceId}`
          : `#pullrequestreview-${sourceId}`
  return {
    key,
    account,
    author,
    repository: thread.repository,
    issueNumber: thread.number,
    title: thread.title,
    body,
    url: `https://github.com/${thread.repository}/${thread.pull || kind === "review" || kind === "review-comment" ? "pull" : "issues"}/${thread.number}${anchor}`,
    source: { kind, id: sourceId, updatedAt },
    threadId: thread.id,
  }
}
function validateMention(mention: GithubMention) {
  if (
    !/^[a-f0-9]{64}(?![\s\S])/.test(mention.key) ||
    !validRepository(mention.repository) ||
    !["issue", "issue-comment", "review-comment", "review"].includes(mention.source.kind) ||
    !isTimestamp(mention.source.updatedAt) ||
    !username.test(mention.account.login)
  )
    throw invalid()
  positiveId(mention.account.id)
  positiveId(mention.source.id)
  positiveId(mention.issueNumber)
  text(mention.title, 2048)
  text(mention.threadId, 128)
}
function validRepository(value: string): boolean {
  const [owner, name, extra] = value.split("/")
  return Boolean(
    owner &&
      username.test(owner) &&
      name &&
      /^[\w.-]{1,100}(?![\s\S])/.test(name) &&
      name !== "." &&
      name !== ".." &&
      extra === undefined,
  )
}
function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z(?![\s\S])/.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}
function positiveId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw invalid()
  return value
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) throw invalid()
  return value
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw invalid()
  return value
}
