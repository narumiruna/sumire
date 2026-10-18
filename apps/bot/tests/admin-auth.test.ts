import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, expect, it } from "vitest"
import { createPasskeySetup, PasskeyAdminLogin } from "../src/admin/auth.js"
import { TestAdminStore as AdminStore } from "./helpers/admin-store.js"

import { createPasskeyFixture, passkeyOrigin } from "./helpers/passkey-fixture.js"

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sumire-passkey-"))
  const store = new AdminStore(path.join(root, "admin.sqlite"), new Set([42]), 42)
  cleanup.push(async () => {
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  const login = new PasskeyAdminLogin(
    { origin: passkeyOrigin, host: "127.0.0.1", port: 0, assets: root },
    store,
  )
  const link = createPasskeySetup(store, passkeyOrigin) as string
  const secret = new URLSearchParams(new URL(link).hash.slice(1)).get("setup") as string
  const fixture = createPasskeyFixture()
  const register = async () => {
    const start = await login.beginRegistration(secret)
    await login.finishRegistration(start.browser, fixture.registration(start.options.challenge))
    return start.options.user.id
  }
  return { store, login, secret, fixture, register }
}

it("offers only stable passkey algorithms", async () => {
  const { login, secret } = await setup()
  const { options } = await login.beginRegistration(secret)
  expect(options.pubKeyCredParams).toEqual([
    { type: "public-key", alg: -8 },
    { type: "public-key", alg: -7 },
    { type: "public-key", alg: -257 },
  ])
})

it("rejects registration with an algorithm outside the stable list", async () => {
  const { login, secret, store } = await setup()
  const fixture = createPasskeyFixture(-48)
  const start = await login.beginRegistration(secret)
  await expect(
    login.finishRegistration(start.browser, fixture.registration(start.options.challenge)),
  ).rejects.toThrow("Passkey verification failed or expired")
  expect(store.db.prepare("SELECT * FROM passkeys").all()).toEqual([])
})

it("registers a verified passkey, authenticates, updates its counter, and closes bootstrap", async () => {
  const { store, login, secret, fixture, register } = await setup()
  expect(JSON.stringify(store.db.prepare("SELECT * FROM passkey_setup").all())).not.toContain(
    secret,
  )
  const user = await register()
  expect(createPasskeySetup(store, passkeyOrigin)).toBeUndefined()
  await expect(login.beginRegistration(secret)).rejects.toThrow()
  const start = await login.beginAuthentication()
  expect(start.options.userVerification).toBe("required")
  expect(start.options.allowCredentials ?? []).toEqual([])
  expect(
    await login.finishAuthentication(
      start.browser,
      fixture.authentication(start.options.challenge, user),
    ),
  ).toBe("42")
  expect(store.db.prepare("SELECT counter FROM passkeys").get()).toMatchObject({ counter: 1 })
  await expect(
    login.finishAuthentication(
      start.browser,
      fixture.authentication(start.options.challenge, user),
    ),
  ).rejects.toThrow()
})

it.each(["invalid", "expired", "replaced", "origin"])(
  "rejects %s setup authorization",
  async (kind) => {
    const { store, login, secret } = await setup()
    if (kind === "expired") store.db.exec("UPDATE passkey_setup SET created=0")
    if (kind === "replaced") createPasskeySetup(store, passkeyOrigin)
    if (kind === "origin")
      store.db.prepare("UPDATE passkey_setup SET origin=?").run("https://other.example.test")
    await expect(login.beginRegistration(kind === "invalid" ? "wrong" : secret)).rejects.toThrow()
  },
)

it.each([
  "browser",
  "expired",
  "challenge",
  "origin",
  "rpID",
  "verification",
  "replay",
  "token-replaced",
])("rejects %s registration", async (kind) => {
  const { store, login, secret, fixture } = await setup()
  const start = await login.beginRegistration(secret)
  if (kind === "expired") store.db.exec("UPDATE passkey_challenges SET created=0")
  if (kind === "token-replaced") createPasskeySetup(store, passkeyOrigin)
  const response = fixture.registration(kind === "challenge" ? "wrong" : start.options.challenge, {
    ...(kind === "origin" ? { origin: "https://other.example.test" } : {}),
    ...(kind === "rpID" ? { rpID: "other.example.test" } : {}),
    ...(kind === "verification" ? { flags: 0x41 } : {}),
  })
  if (kind === "replay") await login.finishRegistration(start.browser, response)
  await expect(
    login.finishRegistration(kind === "browser" ? "wrong" : start.browser, response),
  ).rejects.toThrow()
  if (kind !== "replay") expect(store.db.prepare("SELECT * FROM passkeys").all()).toEqual([])
})

it.each([
  "browser",
  "expired",
  "challenge",
  "origin",
  "rpID",
  "verification",
  "signature",
  "handle",
  "actor",
  "counter",
])("rejects %s authentication", async (kind) => {
  const { store, login, fixture, register } = await setup()
  const user = await register()
  const start = await login.beginAuthentication()
  if (kind === "expired") store.db.exec("UPDATE passkey_challenges SET created=0")
  if (kind === "actor") store.db.exec("UPDATE passkeys SET actor='43'")
  if (kind === "counter") store.db.exec("UPDATE passkeys SET counter=1")
  const response = fixture.authentication(
    kind === "challenge" ? "wrong" : start.options.challenge,
    kind === "handle" ? "wrong" : user,
    {
      ...(kind === "origin" ? { origin: "https://other.example.test" } : {}),
      ...(kind === "rpID" ? { rpID: "other.example.test" } : {}),
      ...(kind === "verification" ? { flags: 0x01 } : {}),
    },
  )
  if (kind === "signature") response.response.signature = Buffer.alloc(64).toString("base64url")
  await expect(
    login.finishAuthentication(kind === "browser" ? "wrong" : start.browser, response),
  ).rejects.toThrow()
})

it("does not register two credentials from concurrent setup requests", async () => {
  const { login, secret, store } = await setup()
  const first = createPasskeyFixture()
  const second = createPasskeyFixture()
  const a = await login.beginRegistration(secret)
  const b = await login.beginRegistration(secret)
  const results = await Promise.allSettled([
    login.finishRegistration(a.browser, first.registration(a.options.challenge)),
    login.finishRegistration(b.browser, second.registration(b.options.challenge)),
  ])
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
  expect(store.db.prepare("SELECT * FROM passkeys").all()).toHaveLength(1)
})

it("supports synced passkeys with a zero counter and persists credentials across service recreation", async () => {
  const { store, login, fixture, secret } = await setup()
  const start = await login.beginRegistration(secret)
  await login.finishRegistration(
    start.browser,
    fixture.registration(start.options.challenge, { flags: 0x5d }),
  )
  const reopened = new AdminStore(store.file, new Set(), 42)
  try {
    const next = new PasskeyAdminLogin(login.config, reopened)
    for (let i = 0; i < 2; i++) {
      const pending = await next.beginAuthentication()
      expect(
        await next.finishAuthentication(
          pending.browser,
          fixture.authentication(pending.options.challenge, start.options.user.id, {
            counter: 0,
            flags: 0x1d,
          }),
        ),
      ).toBe("42")
    }
    expect(
      reopened.db.prepare("SELECT counter, backed_up, device_type FROM passkeys").get(),
    ).toMatchObject({ counter: 0, backed_up: 1, device_type: "multiDevice" })
  } finally {
    reopened.close()
  }
})

it("bounds pending challenges", async () => {
  const { login } = await setup()
  for (let i = 0; i < 64; i++) await login.beginAuthentication()
  await expect(login.beginAuthentication()).rejects.toThrow("Too many pending logins")
})
