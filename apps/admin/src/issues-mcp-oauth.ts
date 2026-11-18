export type IssuesMcpScope = "issues:read" | "issues:write"

/** null is not a consent link; an empty ID is a malformed consent link. Never persist it. */
export function readIssuesMcpRequest(hash: string): string | null {
  if (hash !== "#issues-mcp" && !hash.startsWith("#issues-mcp=")) return null
  return /^#issues-mcp=([A-Za-z0-9_-]{43})$/.exec(hash)?.[1] ?? ""
}

export function isIssuesMcpCallback(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}\/(?!\/)/.test(value) &&
    !/[?#\\]/.test(value) &&
    URL.parse(value)?.href === value
  )
}

/** Only navigate to the exact callback shown to the admin, with the expected OAuth response. */
export function validateIssuesMcpRedirect(
  callback: string,
  redirect: unknown,
  approve: boolean,
  origin: string,
): string | undefined {
  if (typeof redirect !== "string" || redirect.includes("#")) return undefined
  const queryStart = redirect.indexOf("?")
  if (
    queryStart === -1 ||
    redirect.slice(0, queryStart) !== callback ||
    !isIssuesMcpCallback(callback)
  )
    return undefined
  const url = URL.parse(redirect)
  if (url?.href !== redirect) return undefined
  const params = url.searchParams
  const result = approve ? "code" : "error"
  if (params.size !== 3 || params.getAll("iss").length !== 1 || params.get("iss") !== origin)
    return undefined
  if (params.getAll("state").length !== 1 || !params.get("state")) return undefined
  const value = params.get(result)
  if (params.getAll(result).length !== 1 || !value || (!approve && value !== "access_denied"))
    return undefined
  return redirect
}
