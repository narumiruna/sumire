import { createHash } from "node:crypto"
import { readResponseText } from "@narumitw/sumire-url-content/network"
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose"
import { AdminError, type AdminStore, digest, token } from "./store.js"

export interface AdminConfig {
  origin: string
  clientId: string
  clientSecret: string
  port: number
  host: string
  assets: string
}
const issuer = "https://oauth.telegram.org"
const keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
  timeoutDuration: 5000,
})

export async function verifyTelegramToken(
  jwt: string,
  clientId: string,
  nonce: string,
  adminId: number | undefined,
  key: JWTVerifyGetKey = keys,
) {
  const { payload } = await jwtVerify(jwt, key, {
    algorithms: ["RS256"],
    issuer,
    audience: clientId,
    maxTokenAge: "5m",
    requiredClaims: ["sub", "iat", "exp", "nonce", "id"],
  })
  if (
    payload.nonce !== nonce ||
    typeof payload.sub !== "string" ||
    !payload.sub ||
    !adminId ||
    payload.id !== adminId
  )
    throw new AdminError(403, "Administrator access denied")
  return String(adminId)
}

export class TelegramAdminLogin {
  constructor(
    readonly config: AdminConfig,
    readonly store: AdminStore,
  ) {}
  begin() {
    if (!this.store.adminId) throw new AdminError(503, "Administrator login is not configured")
    this.store.prune()
    const count = this.store.db.prepare("SELECT COUNT(*) AS n FROM login").get() as { n: number }
    if (count.n >= 64) throw new AdminError(429, "Too many pending logins")
    const browser = token()
    const state = token()
    const nonce = token()
    const verifier = token()
    this.store.db
      .prepare("INSERT INTO login VALUES (?,?,?,?,?)")
      .run(digest(browser), state, nonce, verifier, Date.now())
    const url = new URL(`${issuer}/auth`)
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: `${this.config.origin}/auth/callback`,
      response_type: "code",
      scope: "openid profile",
      state,
      nonce,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString()
    return { browser, url: url.href }
  }
  async finish(browser: string, code: string, state: string) {
    this.store.prune()
    const pending = this.store.db
      .prepare("DELETE FROM login WHERE hash=? RETURNING *")
      .get(digest(browser)) as { state: string; nonce: string; verifier: string } | undefined
    if (!pending || pending.state !== state || !code || code.length > 4096)
      throw new AdminError(403, "Invalid or expired login")
    const signal = AbortSignal.timeout(10_000)
    const response = await fetch(`${issuer}/token`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${this.config.origin}/auth/callback`,
        client_id: this.config.clientId,
        code_verifier: pending.verifier,
      }),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new AdminError(403, "Telegram login failed")
    }
    const input: unknown = JSON.parse(await readResponseText(response, 65536, signal))
    if (
      !input ||
      typeof input !== "object" ||
      !("id_token" in input) ||
      typeof input.id_token !== "string"
    )
      throw new AdminError(403, "Telegram login failed")
    return verifyTelegramToken(
      input.id_token,
      this.config.clientId,
      pending.nonce,
      this.store.adminId,
    )
  }
}
