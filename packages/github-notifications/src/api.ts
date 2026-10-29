export interface GithubMentionClientOptions {
  /** Reject unless the current configuration is saved and applied. */
  authorize(): void
  token(): string | undefined
  allowedUsernames(): readonly string[]
  fetch?: typeof fetch
}

export class GithubError extends Error {}
export class GithubHttpError extends GithubError {
  constructor(readonly status: number) {
    super(`GitHub mention request failed (HTTP ${status})`)
  }
}
export const invalid = () => new GithubError("GitHub returned invalid mention data")

/** One operation keeps one credential and fixed API origin, with bounded time, bytes, and requests. */
export function openApi(options: GithubMentionClientOptions, signal?: AbortSignal) {
  options.authorize()
  signal?.throwIfAborted()
  const token = options.token()
  if (!token || !/^[\x21-\x7e]+(?![\s\S])/.test(token))
    throw new GithubError("An applied GH_TOKEN secret is required")
  const operationSignal = AbortSignal.timeout(120_000)
  let requests = 0
  let bytes = 0
  const assert = () => {
    signal?.throwIfAborted()
    operationSignal.throwIfAborted()
    options.authorize()
    if (options.token() !== token) throw new GithubError("GitHub credentials changed")
  }
  return {
    assert,
    async request(path: string, body?: { body: string }) {
      assert()
      if (!path.startsWith("/") || path.startsWith("//") || /[\\#\r\n]/.test(path)) throw invalid()
      const url = new URL(path, "https://api.github.com")
      if (url.origin !== "https://api.github.com" || ++requests > 200)
        throw new GithubError("GitHub mention request limit exceeded")
      const boundedSignal = AbortSignal.any([
        ...(signal ? [signal] : []),
        operationSignal,
        AbortSignal.timeout(15_000),
      ])
      let response: Response | undefined
      try {
        response = await (options.fetch ?? fetch)(url, {
          method: body ? "POST" : "GET",
          redirect: "error",
          signal: boundedSignal,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "sumire-github-mentions",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
        if (!response.ok) throw new GithubHttpError(response.status)
        const length = response.headers.get("content-length")
        if (length && Number(length) > 2 * 1024 * 1024)
          throw new GithubError("GitHub mention response exceeds the size limit")
        if (!response.body) throw invalid()
        const reader = response.body.getReader()
        const chunks: Uint8Array[] = []
        let size = 0
        try {
          for (;;) {
            boundedSignal.throwIfAborted()
            const { done, value } = await reader.read()
            if (done) break
            size += value.byteLength
            bytes += value.byteLength
            if (size > 2 * 1024 * 1024 || bytes > 8 * 1024 * 1024)
              throw new GithubError("GitHub mention response exceeds the size limit")
            chunks.push(value)
          }
        } finally {
          await reader.cancel().catch(() => {})
        }
        let data: unknown
        try {
          data = JSON.parse(Buffer.concat(chunks).toString("utf8"))
        } catch {
          throw invalid()
        }
        boundedSignal.throwIfAborted()
        assert()
        return { data, headers: response.headers }
      } catch (error) {
        signal?.throwIfAborted()
        options.authorize()
        if (options.token() !== token) throw new GithubError("GitHub credentials changed")
        if (error instanceof GithubError) throw error
        throw new GithubError("GitHub mention request failed or timed out")
      } finally {
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {})
      }
    },
  }
}
