import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server"
import { COSEALG } from "@simplewebauthn/server/helpers"
import { AdminError, type AdminStore, digest, token } from "./store.js"

export interface AdminConfig {
  origin: string
  port: number
  host: string
  assets: string
  /** The v2 console build, served under /v2/; omitted when it is not deployed. */
  assetsV2?: string
}

type Pending = {
  actor: string
  kind: string
  challenge: string
  setup_hash: string
  user_handle: string
}
type Credential = {
  id: string
  public_key: Uint8Array
  counter: number
  user_handle: string
}
// Use stable Web Crypto algorithms for both registration and verification.
const supportedAlgorithmIDs = [COSEALG.EdDSA, COSEALG.ES256, COSEALG.RS256]
const denied = () => new AdminError(403, "Passkey verification failed or expired")

/** Called only after the Telegram transport verifies the private bootstrap administrator. */
export function createPasskeySetup(store: AdminStore, origin: string) {
  if (!store.adminId) throw denied()
  const actor = String(store.adminId)
  if (store.db.prepare("SELECT id FROM passkeys WHERE actor=?").get(actor)) return undefined
  store.prune()
  const value = token()
  store.db
    .prepare(
      "INSERT INTO passkey_setup VALUES (?,?,?,?) ON CONFLICT(actor) DO UPDATE SET hash=excluded.hash,origin=excluded.origin,created=excluded.created",
    )
    .run(actor, digest(value), origin, Date.now())
  return `${origin}/#setup=${value}`
}

export class PasskeyAdminLogin {
  private readonly rpID: string
  constructor(
    readonly config: AdminConfig,
    readonly store: AdminStore,
  ) {
    this.rpID = new URL(config.origin).hostname
  }
  private actor() {
    if (!this.store.adminId) throw denied()
    return String(this.store.adminId)
  }
  private setup(hash: string) {
    this.store.prune()
    if (
      this.store.db.prepare("SELECT id FROM passkeys WHERE actor=?").get(this.actor()) ||
      !this.store.db
        .prepare("SELECT actor FROM passkey_setup WHERE actor=? AND hash=? AND origin=?")
        .get(this.actor(), hash, this.config.origin)
    )
      throw denied()
  }
  private pending(kind: string, challenge: string, setupHash = "", userHandle = "") {
    this.store.prune()
    const count = this.store.db.prepare("SELECT COUNT(*) AS n FROM passkey_challenges").get() as {
      n: number
    }
    if (count.n >= 64) throw new AdminError(429, "Too many pending logins")
    const browser = token()
    this.store.db
      .prepare("INSERT INTO passkey_challenges VALUES (?,?,?,?,?,?,?)")
      .run(digest(browser), this.actor(), kind, challenge, setupHash, userHandle, Date.now())
    return browser
  }
  private take(browser: string, kind: string): Pending {
    this.store.prune()
    const pending = this.store.db
      .prepare("DELETE FROM passkey_challenges WHERE hash=? RETURNING *")
      .get(digest(browser)) as Pending | undefined
    if (!pending || pending.actor !== this.actor() || pending.kind !== kind) throw denied()
    return pending
  }
  async beginRegistration(setupToken: string) {
    const setupHash = digest(setupToken)
    this.setup(setupHash)
    const options = await generateRegistrationOptions({
      rpName: "Sumire administration",
      rpID: this.rpID,
      userName: "Administrator",
      attestationType: "none",
      supportedAlgorithmIDs,
      timeout: 60_000,
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    })
    this.setup(setupHash)
    return {
      options,
      browser: this.pending("register", options.challenge, setupHash, options.user.id),
    }
  }
  async finishRegistration(browser: string, response: RegistrationResponseJSON) {
    const pending = this.take(browser, "register")
    this.setup(pending.setup_hash)
    let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>
    try {
      result = await verifyRegistrationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.rpID,
        requireUserVerification: true,
        supportedAlgorithmIDs,
      })
    } catch {
      throw denied()
    }
    if (!result.verified) throw denied()
    const info = result.registrationInfo
    this.store.db.exec("BEGIN IMMEDIATE")
    try {
      this.setup(pending.setup_hash)
      this.store.db
        .prepare("INSERT INTO passkeys VALUES (?,?,?,?,?,?,?)")
        .run(
          pending.actor,
          info.credential.id,
          info.credential.publicKey,
          info.credential.counter,
          pending.user_handle,
          info.credentialDeviceType,
          Number(info.credentialBackedUp),
        )
      this.store.db.prepare("DELETE FROM passkey_setup WHERE actor=?").run(pending.actor)
      this.store.db.prepare("DELETE FROM passkey_challenges WHERE actor=?").run(pending.actor)
      this.store.audit(
        pending.actor,
        "admin.passkey.register",
        this.store.snapshot().revision,
        "completed",
        "administrator",
      )
      this.store.db.exec("COMMIT")
    } catch (error) {
      this.store.db.exec("ROLLBACK")
      throw error
    }
    return pending.actor
  }
  async beginAuthentication() {
    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      userVerification: "required",
      timeout: 60_000,
    })
    return { options, browser: this.pending("authenticate", options.challenge) }
  }
  async finishAuthentication(browser: string, response: AuthenticationResponseJSON) {
    const pending = this.take(browser, "authenticate")
    const credential = this.store.db
      .prepare("SELECT * FROM passkeys WHERE actor=? AND id=?")
      .get(pending.actor, typeof response?.id === "string" ? response.id : "") as
      | Credential
      | undefined
    if (!credential || response.response?.userHandle !== credential.user_handle) throw denied()
    let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>
    try {
      result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: pending.challenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.rpID,
        requireUserVerification: true,
        credential: {
          id: credential.id,
          publicKey: new Uint8Array(credential.public_key),
          counter: credential.counter,
        },
      })
    } catch {
      throw denied()
    }
    if (!result.verified) throw denied()
    const info = result.authenticationInfo
    const changed = this.store.db
      .prepare(
        "UPDATE passkeys SET counter=?,device_type=?,backed_up=? WHERE actor=? AND id=? AND counter=? AND public_key=?",
      )
      .run(
        info.newCounter,
        info.credentialDeviceType,
        Number(info.credentialBackedUp),
        pending.actor,
        credential.id,
        credential.counter,
        credential.public_key,
      )
    if (!changed.changes) throw denied()
    return pending.actor
  }
}
