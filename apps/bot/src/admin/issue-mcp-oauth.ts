import { createHash } from "node:crypto"
import { z } from "zod"
import { AdminError, type AdminStore, digest, token } from "./store.js"

export const issueMcpPath = "/mcp/issues"
export const resourceMetadataPath = `/.well-known/oauth-protected-resource${issueMcpPath}`
export const authorizationMetadataPath = "/.well-known/oauth-authorization-server"
export const oauthPath = "/oauth/issues"
export const readScope = "issues:read"
export const writeScope = "issues:write"
const scopes = z.enum([readScope, writeScope])
export type IssueMcpScope = z.infer<typeof scopes>
export const opaqueId = z.string().regex(/^[a-zA-Z0-9_-]{43}$/)
const verifier = z.string().regex(/^[a-zA-Z0-9._~-]{43,128}$/)
const minute = 60_000
const accessAge = 60 * minute
const grantAge = 30 * 24 * 60 * minute
const browserAge = 10 * minute
const maxGrants = 64
const maxRefreshes = 1024

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code)
  }
}

const registrationInput = z.object({
  client_name: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u)
    .default("Coding agent"),
  redirect_uris: z.array(z.string().max(512)).min(1).max(5),
  token_endpoint_auth_method: z.literal("none").optional(),
  grant_types: z
    .array(z.enum(["authorization_code", "refresh_token"]))
    .min(1)
    .max(2)
    .optional(),
  response_types: z.tuple([z.literal("code")]).optional(),
})
const authorizationInput = z.object({
  client_id: opaqueId,
  redirect_uri: z.string().max(512),
  response_type: z.literal("code"),
  code_challenge: opaqueId,
  code_challenge_method: z.literal("S256"),
  state: z.string().min(1).max(512),
  scope: z.string().max(128).optional(),
  resource: z.string().max(512).optional(),
})
const exchangeInput = z.discriminatedUnion("grant_type", [
  z.object({
    grant_type: z.literal("authorization_code"),
    client_id: opaqueId,
    code: opaqueId,
    code_verifier: verifier,
    redirect_uri: z.string().max(512),
    resource: z.string().max(512).optional(),
  }),
  z.object({
    grant_type: z.literal("refresh_token"),
    client_id: opaqueId,
    refresh_token: opaqueId,
    resource: z.string().max(512).optional(),
    scope: z.string().max(128).optional(),
  }),
])
const revocationInput = z.object({ client_id: opaqueId, token: z.string().min(1).max(128) })

interface Client {
  name: string
  redirects: string
}
interface RequestRow {
  client: string
  actor: string
  redirect: string
  challenge: string
  scope: IssueMcpScope
  state: string
  name: string
}
interface GrantRow {
  id: string
  scope: IssueMcpScope
  expires: number
  rotations: number
  used: number
}

function loopback(value: string) {
  // Allow an explicit port on a native-app callback, never a remote URL, credentials,
  // a fragment, or existing query fields that could conflict with the OAuth response.
  if (!/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}\/(?!\/)/.test(value))
    return undefined
  const url = URL.parse(value)
  if (!url || url.href !== value || /[?#]/.test(value) || url.username || url.password)
    return undefined
  return url
}

export class IssueMcpOAuth {
  readonly endpoint: string | null

  constructor(
    private readonly store: AdminStore,
    private readonly origin: string,
  ) {
    this.endpoint = new URL(origin).protocol === "https:" ? `${origin}${issueMcpPath}` : null
  }

  resourceMetadata() {
    return {
      resource: this.endpoint,
      authorization_servers: [this.origin],
      bearer_methods_supported: ["header"],
      scopes_supported: [readScope, writeScope],
    }
  }

  authorizationMetadata() {
    const base = `${this.origin}${oauthPath}`
    return {
      issuer: this.origin,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      revocation_endpoint: `${base}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
      scopes_supported: [readScope, writeScope],
    }
  }

  challenge(error?: "invalid_token" | "insufficient_scope") {
    return `Bearer resource_metadata="${this.origin}${resourceMetadataPath}", scope="${error === "insufficient_scope" ? writeScope : readScope}"${error ? `, error="${error}"` : ""}`
  }

  register(value: unknown) {
    const result = registrationInput.safeParse(value)
    if (!result.success) throw new OAuthError("invalid_client_metadata")
    const input = result.data
    if (!input.redirect_uris.every(loopback)) throw new OAuthError("invalid_redirect_uri")
    if (input.grant_types && !input.grant_types.includes("authorization_code"))
      throw new OAuthError("invalid_client_metadata")
    const now = Date.now()
    const id = token()
    const redirects = JSON.stringify(input.redirect_uris)
    return this.transaction(() => {
      this.prune(now)
      const count = this.store.db
        .prepare("SELECT count(*) AS n FROM issues_oauth_clients")
        .get() as { n: number }
      if (count.n >= 256) throw new OAuthError("temporarily_unavailable", 503)
      this.store.db
        .prepare("INSERT INTO issues_oauth_clients VALUES (?,?,?,?,?)")
        .run(id, this.origin, input.client_name, redirects, now + 20 * minute)
      return {
        client_id: id,
        client_name: input.client_name,
        redirect_uris: input.redirect_uris,
        client_id_issued_at: Math.floor(now / 1000),
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }
    })
  }

  begin(value: unknown, browserCookie: string) {
    const parsed = authorizationInput.safeParse(value)
    if (!parsed.success || !this.store.adminId) throw new OAuthError("invalid_request")
    const input = parsed.data
    this.resource(input.resource)
    const scope = this.scope(input.scope)
    const now = Date.now()
    const browser = opaqueId.safeParse(browserCookie).success ? browserCookie : token()
    const id = token()
    this.transaction(() => {
      this.prune(now)
      const client = this.store.db
        .prepare("SELECT name, redirects FROM issues_oauth_clients WHERE id=? AND origin=?")
        .get(input.client_id, this.origin) as Client | undefined
      const redirect = loopback(input.redirect_uri)
      const matches =
        redirect &&
        client &&
        (JSON.parse(client.redirects) as string[]).some((value) => {
          const registered = loopback(value)
          // RFC 8252 permits a native app to choose a new loopback port at runtime.
          return (
            registered?.hostname === redirect.hostname &&
            registered.pathname === redirect.pathname &&
            (redirect.hostname !== "localhost" || registered.port === redirect.port)
          )
        })
      if (!matches) throw new OAuthError("invalid_request")
      const count = this.store.db
        .prepare("SELECT count(*) AS n FROM issues_oauth_requests")
        .get() as { n: number }
      if (count.n >= 256) throw new OAuthError("temporarily_unavailable", 503)
      this.store.db
        .prepare(`INSERT INTO issues_oauth_requests
        (id,browser,client,actor,redirect,challenge,scope,state,expires) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(
          digest(id),
          digest(browser),
          input.client_id,
          String(this.store.adminId),
          input.redirect_uri,
          input.code_challenge,
          scope,
          input.state,
          now + browserAge,
        )
    })
    return { id, browser, seconds: browserAge / 1000 }
  }

  review(id: string, browser: string, actor: string) {
    const { name, redirect, scope } = this.pending(id, browser, actor)
    return { clientName: name, redirectUri: redirect, scope }
  }

  decide(id: string, browser: string, actor: string, approve: boolean) {
    return this.transaction(() => {
      const request = this.pending(id, browser, actor)
      const callback = new URL(request.redirect)
      callback.searchParams.set("state", request.state)
      callback.searchParams.set("iss", this.origin)
      if (approve) {
        const code = token()
        this.store.db
          .prepare("UPDATE issues_oauth_requests SET code=?, expires=? WHERE id=?")
          .run(digest(code), Date.now() + minute, digest(id))
        callback.searchParams.set("code", code)
      } else {
        this.store.db.prepare("DELETE FROM issues_oauth_requests WHERE id=?").run(digest(id))
        callback.searchParams.set("error", "access_denied")
      }
      return { redirect: callback.href }
    })
  }

  exchange(value: unknown) {
    const parsed = exchangeInput.safeParse(value)
    if (!parsed.success) throw new OAuthError("invalid_request")
    const input = parsed.data
    this.resource(input.resource)
    const now = Date.now()
    const result = this.transaction(() => {
      if (input.grant_type === "authorization_code") {
        this.prune(now)
        const request = this.store.db
          .prepare(`SELECT r.* FROM issues_oauth_requests r
          JOIN issues_oauth_clients c ON c.id=r.client WHERE code=? AND r.client=? AND c.origin=? AND r.actor=? AND r.expires>?`)
          .get(digest(input.code), input.client_id, this.origin, String(this.store.adminId), now) as
          | RequestRow
          | undefined
        if (
          !request ||
          request.redirect !== input.redirect_uri ||
          request.challenge !== createHash("sha256").update(input.code_verifier).digest("base64url")
        )
          return undefined
        this.store.db
          .prepare("DELETE FROM issues_oauth_requests WHERE code=?")
          .run(digest(input.code))
        const count = this.store.db
          .prepare("SELECT count(*) AS n FROM issues_oauth_grants")
          .get() as { n: number }
        if (count.n >= maxGrants) throw new OAuthError("temporarily_unavailable", 503)
        const id = token()
        const expires = now + grantAge
        this.store.db
          .prepare("UPDATE issues_oauth_clients SET expires=? WHERE id=?")
          .run(expires + grantAge, request.client)
        this.store.db
          .prepare(
            "INSERT INTO issues_oauth_grants (id,client,actor,redirect,scope,expires) VALUES (?,?,?,?,?,?)",
          )
          .run(id, request.client, request.actor, request.redirect, request.scope, expires)
        this.audit(request.actor, "issue.mcp.oauth.grant", id)
        return this.issueTokens(id, request.scope, expires, now)
      }
      const hash = digest(input.refresh_token)
      const grant = this.store.db
        .prepare(`SELECT g.id,g.scope,g.expires,g.rotations,r.used FROM issues_oauth_refresh r
        JOIN issues_oauth_grants g ON g.id=r.grant_id JOIN issues_oauth_clients c ON c.id=g.client
        WHERE r.hash=? AND g.client=? AND c.origin=? AND g.actor=? AND g.expires>?`)
        .get(hash, input.client_id, this.origin, String(this.store.adminId), now) as
        | GrantRow
        | undefined
      if (!grant) return undefined
      if (grant.used || grant.rotations >= maxRefreshes) {
        this.removeGrant(grant.id, String(this.store.adminId))
        return undefined
      }
      if (input.scope !== undefined && this.scope(input.scope) !== grant.scope)
        throw new OAuthError("invalid_scope")
      this.store.db.prepare("UPDATE issues_oauth_refresh SET used=1 WHERE hash=?").run(hash)
      this.store.db
        .prepare("UPDATE issues_oauth_grants SET rotations=rotations+1 WHERE id=?")
        .run(grant.id)
      return this.issueTokens(grant.id, grant.scope, grant.expires, now)
    })
    if (!result) throw new OAuthError("invalid_grant")
    return result
  }

  revoke(value: unknown) {
    const parsed = revocationInput.safeParse(value)
    if (!parsed.success) throw new OAuthError("invalid_request")
    const { client_id: client, token: supplied } = parsed.data
    this.transaction(() => {
      const hash = digest(supplied)
      const actor = String(this.store.adminId)
      const grant = this.store.db
        .prepare(`SELECT g.id FROM issues_oauth_grants g JOIN issues_oauth_clients c ON c.id=g.client
        WHERE g.client=? AND c.origin=? AND g.actor=? AND (g.access=? OR EXISTS
          (SELECT 1 FROM issues_oauth_refresh WHERE hash=? AND grant_id=g.id))`)
        .get(client, this.origin, actor, hash, hash) as { id: string } | undefined
      if (grant) this.removeGrant(grant.id, actor)
    })
  }

  authenticate(authorization: string | undefined) {
    const match = /^Bearer ([a-zA-Z0-9_-]{43})$/i.exec(authorization ?? "")?.[1]
    if (!match || !this.endpoint || !this.store.adminId) return undefined
    return this.store.db
      .prepare(`SELECT g.actor,g.scope FROM issues_oauth_grants g JOIN issues_oauth_clients c ON c.id=g.client
      WHERE g.access=? AND g.access_expires>? AND g.actor=? AND c.origin=?`)
      .get(digest(match), Date.now(), String(this.store.adminId), this.origin) as
      | { actor: string; scope: IssueMcpScope }
      | undefined
  }

  grants(actor: string) {
    return {
      endpoint: this.endpoint,
      grants: this.endpoint
        ? this.store.db
            .prepare(`SELECT g.id,c.name AS clientName,g.redirect AS redirectUri,g.scope,g.expires AS expiresAt
        FROM issues_oauth_grants g JOIN issues_oauth_clients c ON c.id=g.client
        WHERE g.actor=? AND c.origin=? AND g.expires>? ORDER BY g.expires DESC, g.id`)
            .all(actor, this.origin, Date.now())
        : [],
    }
  }

  revokeGrant(id: string, actor: string) {
    this.transaction(() => this.removeGrant(id, actor))
    return this.grants(actor)
  }

  private pending(id: string, browser: string, actor: string) {
    if (!this.endpoint || !opaqueId.safeParse(browser).success)
      throw new AdminError(404, "Authorization request expired or not found")
    const request = this.store.db
      .prepare(`SELECT r.*,c.name FROM issues_oauth_requests r JOIN issues_oauth_clients c ON c.id=r.client
      WHERE r.id=? AND r.browser=? AND r.actor=? AND c.origin=? AND r.code IS NULL AND r.expires>?`)
      .get(digest(id), digest(browser), actor, this.origin, Date.now()) as RequestRow | undefined
    if (!request) throw new AdminError(404, "Authorization request expired or not found")
    return request
  }

  private resource(value: string | undefined) {
    // This authorization server has exactly one audience, even for older clients that omit it.
    if (value !== undefined && value !== this.endpoint) throw new OAuthError("invalid_target")
  }

  private scope(value: string | undefined) {
    const requested = value?.split(/ +/).filter(Boolean) ?? []
    if (requested.some((scope) => !scopes.safeParse(scope).success))
      throw new OAuthError("invalid_scope")
    return requested.includes(writeScope) ? writeScope : readScope
  }

  private issueTokens(id: string, scope: IssueMcpScope, expires: number, now: number) {
    const access = token()
    const refresh = token()
    const expiresAt = Math.min(expires, now + accessAge)
    this.store.db
      .prepare("UPDATE issues_oauth_grants SET access=?, access_expires=? WHERE id=?")
      .run(digest(access), expiresAt, id)
    this.store.db
      .prepare("INSERT INTO issues_oauth_refresh VALUES (?,?,0)")
      .run(digest(refresh), id)
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: Math.ceil((expiresAt - now) / 1000),
      scope,
    }
  }

  private removeGrant(id: string, actor: string) {
    const { changes } = this.store.db
      .prepare(`DELETE FROM issues_oauth_grants WHERE id=? AND actor=?
      AND client IN (SELECT id FROM issues_oauth_clients WHERE origin=?)`)
      .run(id, actor, this.origin)
    if (changes) this.audit(actor, "issue.mcp.oauth.revoke", id)
  }

  private audit(actor: string, operation: string, id: string) {
    this.store.audit(
      actor,
      operation,
      this.store.snapshot().revision,
      "completed",
      `issue-mcp-grant:${id}`,
    )
  }

  private prune(now: number) {
    this.store.db.prepare("DELETE FROM issues_oauth_requests WHERE expires<=?").run(now)
    this.store.db.prepare("DELETE FROM issues_oauth_grants WHERE expires<=?").run(now)
    this.store.db
      .prepare(`DELETE FROM issues_oauth_clients WHERE expires<=? AND NOT EXISTS
      (SELECT 1 FROM issues_oauth_requests WHERE client=issues_oauth_clients.id)`)
      .run(now)
  }

  private transaction<T>(work: () => T): T {
    this.store.db.exec("BEGIN IMMEDIATE")
    try {
      const result = work()
      this.store.db.exec("COMMIT")
      return result
    } catch (error) {
      this.store.db.exec("ROLLBACK")
      throw error
    }
  }
}
