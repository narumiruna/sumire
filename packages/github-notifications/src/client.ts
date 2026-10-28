export interface NotificationQuery {
  all?: boolean
  participating?: boolean
  page?: number
  perPage?: number
}
export interface Notification {
  id: string
  repository: string
  private: boolean
  title: string
  type: string
  reason: string
  unread: boolean
  updatedAt: string
  url?: string
}
export interface NotificationPage {
  notifications: Notification[]
  page: number
  perPage: number
  hasMore: boolean
}
export interface NotificationClientOptions {
  /** Must reject unless the current recipient is authorized. Rechecked before returning data. */
  authorize(): void
  token(): string | undefined
  fetch?: typeof fetch
}
const maxBytes = 512 * 1024
class NotificationError extends Error {}
const invalid = () => new NotificationError("GitHub returned invalid notification data")

/** Never executes GitHub CLI, inherits credentials, follows redirects, or marks threads read. */
export function createNotificationClient(options: NotificationClientOptions) {
  return {
    async list(query: NotificationQuery = {}, signal?: AbortSignal): Promise<NotificationPage> {
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
        (query.all !== undefined && typeof query.all !== "boolean") ||
        (query.participating !== undefined && typeof query.participating !== "boolean")
      )
        throw new Error("Invalid GitHub notifications query")
      signal?.throwIfAborted()
      const token = options.token()
      if (!token || !/^[\x21-\x7e]+$/.test(token))
        throw new Error("An applied GH_TOKEN secret is required")
      const url = new URL("https://api.github.com/notifications")
      url.searchParams.set("page", String(page))
      url.searchParams.set("per_page", String(perPage))
      url.searchParams.set("all", String(query.all ?? false))
      url.searchParams.set("participating", String(query.participating ?? false))
      const timeout = AbortSignal.timeout(15_000)
      const boundedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
      let response: Response | undefined
      try {
        response = await (options.fetch ?? fetch)(url, {
          method: "GET",
          redirect: "error",
          signal: boundedSignal,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "sumire-github-notifications",
          },
        })
        if (!response.ok) {
          // Never return the upstream error body, headers, credential, or request object.
          throw new NotificationError(
            `GitHub notifications request failed (HTTP ${response.status})`,
          )
        }
        const payload = await readJson(response)
        if (!Array.isArray(payload) || payload.length > perPage) throw invalid()
        const notifications = payload.map(normalizeNotification)
        boundedSignal.throwIfAborted()
        options.authorize()
        return {
          notifications,
          page,
          perPage,
          hasMore: /rel="next"/.test(response.headers.get("link") ?? ""),
        }
      } catch (error) {
        signal?.throwIfAborted()
        options.authorize()
        if (error instanceof NotificationError) throw error
        throw new Error("GitHub notifications request failed or timed out")
      } finally {
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {})
      }
    },
  }
}

async function readJson(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length")
  if (length && Number(length) > maxBytes)
    throw new NotificationError("GitHub notifications response exceeds the size limit")
  if (!response.body) throw invalid()
  const reader = response.body.getReader()
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes)
        throw new NotificationError("GitHub notifications response exceeds the size limit")
      chunks.push(value)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"))
    } catch {
      throw invalid()
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) throw invalid()
  return value
}
function normalizeNotification(value: unknown): Notification {
  const item = object(value)
  const repository = object(item.repository)
  const subject = object(item.subject)
  if (typeof item.unread !== "boolean" || typeof repository.private !== "boolean") throw invalid()
  const result: Notification = {
    id: text(item.id, 128),
    repository: text(repository.full_name, 256),
    private: repository.private,
    title: text(subject.title, 2048),
    type: text(subject.type, 128),
    reason: text(item.reason, 128),
    unread: item.unread,
    updatedAt: text(item.updated_at, 64),
  }
  // Never expose arbitrary upstream URLs or retrieve thread bodies/comments.
  if (typeof subject.url === "string") {
    const match =
      /^https:\/\/api\.github\.com\/repos\/([\w.-]+\/[\w.-]+)\/(issues|pulls)\/(\d+)$/.exec(
        subject.url,
      )
    if (match && match[1] === result.repository)
      result.url = `https://github.com/${match[1]}/${match[2] === "pulls" ? "pull" : "issues"}/${match[3]}`
  }
  return result
}
