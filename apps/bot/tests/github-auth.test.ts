import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GitHubAuth } from "../src/admin/github-auth.js"
import { RuntimeConfigAdmin } from "../src/admin/runtime-config.js"
import { digest, sessionMaxAgeMs } from "../src/admin/store.js"
import type { GitHubToken } from "../src/github-client.js"
import {
  createGitHubFixture,
  deferred,
  type GitHubFixture,
  githubAccount,
  githubClientId,
  githubSecrets,
  githubToken,
} from "./helpers/github-fixture.js"

let fixture: GitHubFixture
const noSecrets = (value: unknown) => {
  const text = JSON.stringify(value)
  for (const secret of Object.values(githubSecrets)) expect(text).not.toContain(secret)
  expect(text).not.toContain(digest(githubSecrets.accessToken))
}
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  })
  vi.setSystemTime(new Date("2026-10-28T12:00:00Z"))
  fixture = createGitHubFixture()
})
afterEach(async () => {
  await fixture.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("session-owned GitHub device authorization", () => {
  it("reads local connection metadata without starting GitHub requests", async () => {
    const { github, owner, transport, store } = fixture
    const before = store.snapshot()
    expect(github.connection(owner)).toMatchObject({
      mode: "none",
      clientId: githubClientId,
      reconnectRequired: false,
      secretStatus: "ready",
      revision: before.revision,
      applied: before.revision,
      status: "applied",
    })
    expect(await github.resolveToken()).toBeUndefined()
    for (const method of Object.values(transport)) expect(method).not.toHaveBeenCalled()
    expect(store.snapshot()).toEqual(before)
  })

  it("offers a temporary user code but keeps credentials and device codes backend-only", async () => {
    const { github, owner, transport, runtime, store } = fixture
    const before = store.snapshot()
    const flow = await github.start(owner, before.revision, false)
    expect(flow).toMatchObject({
      status: "pending",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      expiresAt: Date.now() + 600_000,
    })
    expect(flow.id).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(transport.device).toHaveBeenCalledWith(githubClientId, expect.any(AbortSignal))
    expect(transport.exchange).not.toHaveBeenCalled()
    expect(transport.account).not.toHaveBeenCalled()
    expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
    expect(store.snapshot()).toEqual(before)
    noSecrets([flow, github.connection(owner), store.listAudit(0)])
  })

  it("binds a flow to the session hash, not the administrator identity", async () => {
    const { github, owner, store } = fixture
    const other = store.createSession("42")
    const otherOwner = digest(other.value)
    const flow = await github.start(owner, store.snapshot().revision, false)
    expect(() => github.state(flow.id, otherOwner)).toThrow("not found")
    await expect(github.cancel(flow.id, otherOwner)).rejects.toMatchObject({ status: 404 })
    await expect(github.complete(flow.id, otherOwner)).rejects.toMatchObject({ status: 404 })
    expect(github.connection(otherOwner)).not.toHaveProperty("flow")
    expect(github.state(flow.id, owner).status).toBe("pending")
    await github.cancelOwner(otherOwner)
    expect(github.state(flow.id, owner).status).toBe("pending")
  })

  it("allows only one active login across administrator sessions", async () => {
    const { github, owner, store, transport } = fixture
    const flow = await github.start(owner, store.snapshot().revision, false)
    const other = digest(store.createSession("42").value)
    await expect(github.start(other, store.snapshot().revision, false)).rejects.toMatchObject({
      status: 409,
    })
    expect(transport.device).toHaveBeenCalledOnce()
    await github.cancel(flow.id, owner)
    expect((await github.start(other, store.snapshot().revision, false)).status).toBe("pending")
  })

  it("retains 16 terminal states, evicts the oldest only for a new flow, and expires receipts", async () => {
    const { github, owner, store } = fixture
    const ids: string[] = []
    for (let i = 0; i < 16; i++) {
      const flow = await github.start(owner, store.snapshot().revision, false)
      ids.push(flow.id)
      await github.cancel(flow.id, owner)
    }
    for (const id of ids) expect(github.state(id, owner).status).toBe("cancelled")
    const next = await github.start(owner, store.snapshot().revision, false)
    await github.cancel(next.id, owner)
    expect(() => github.state(ids[0] ?? "", owner)).toThrow("not found")
    for (const id of ids.slice(1)) expect(github.state(id, owner).status).toBe("cancelled")
    await vi.advanceTimersByTimeAsync(300_001)
    expect(() => github.state(next.id, owner)).toThrow("not found")
    expect(github.connection(owner)).not.toHaveProperty("flow")
  })

  it("polls only on the backend and respects pending, slow_down, and the returned interval", async () => {
    const { github, owner, store, transport } = fixture
    transport.exchange
      .mockResolvedValueOnce({ error: "authorization_pending" })
      .mockResolvedValueOnce({ error: "slow_down", interval: 20 })
      .mockResolvedValueOnce({ error: "slow_down", interval: 1 })
      .mockResolvedValueOnce(githubToken)
    const flow = await github.start(owner, store.snapshot().revision, false)
    for (let i = 0; i < 5; i++) github.state(flow.id, owner)
    await vi.advanceTimersByTimeAsync(4999)
    expect(transport.exchange).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(transport.exchange).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport.exchange).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(19_999)
    expect(transport.exchange).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(transport.exchange).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(24_999)
    expect(transport.exchange).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(transport.exchange).toHaveBeenCalledTimes(4)
    expect(github.state(flow.id, owner).status).toBe("authorized")
    await vi.advanceTimersByTimeAsync(30_000)
    expect(transport.exchange).toHaveBeenCalledTimes(4)
  })

  it("never overlaps an upstream poll with another request", async () => {
    const { github, owner, store, transport } = fixture
    const response = deferred<{ error: string }>()
    transport.exchange.mockReturnValueOnce(response.promise)
    const flow = await github.start(owner, store.snapshot().revision, false)
    await vi.advanceTimersByTimeAsync(25_000)
    const callsWhilePending = transport.exchange.mock.calls.length
    const accountsWhilePending = transport.account.mock.calls.length
    response.resolve({ error: "authorization_pending" })
    expect(callsWhilePending).toBe(1)
    expect(accountsWhilePending).toBe(0)
    await vi.advanceTimersByTimeAsync(4999)
    expect(transport.exchange).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(transport.exchange).toHaveBeenCalledTimes(2)
    await github.cancel(flow.id, owner)
  })

  it("verifies the account and shows actual granted scopes before explicit persistence", async () => {
    const { github, owner, runtime, store, transport } = fixture
    const token = { ...githubToken, scopes: ["read:org"] }
    const before = store.snapshot()
    const flow = await fixture.authorize(token)
    expect(flow).toMatchObject({
      status: "authorized",
      account: githubAccount,
      scopes: ["read:org"],
    })
    expect(flow).not.toHaveProperty("userCode")
    expect(flow).not.toHaveProperty("verificationUri")
    expect(transport.account).toHaveBeenCalledWith(token.accessToken, expect.any(AbortSignal))
    expect(runtime.values.readSecret("GH_TOKEN")).toBeUndefined()
    expect(store.snapshot()).toEqual(before)
    expect(github.connection(owner).flow).toEqual(flow)
    noSecrets([flow, github.connection(owner), store.listAudit(0)])
  })

  it.each(["access_denied", "expired_token", "incorrect_client_credentials"])(
    "clears a terminal GitHub error: %s",
    async (error) => {
      const { github, owner, store, transport } = fixture
      transport.exchange.mockResolvedValueOnce({ error })
      const flow = await github.start(owner, store.snapshot().revision, false)
      await vi.advanceTimersByTimeAsync(5000)
      const state = github.state(flow.id, owner)
      expect(state.status).toBe(error === "expired_token" ? "expired" : "failed")
      expect(state).not.toHaveProperty("userCode")
      expect(state).not.toHaveProperty("verificationUri")
      expect(transport.account).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(transport.exchange).toHaveBeenCalledOnce()
      noSecrets([state, store.listAudit(0)])
    },
  )

  it.each(["device", "exchange", "account"] as const)(
    "uses a fixed safe failure after a rejected %s request",
    async (method) => {
      const { github, owner, store, transport, runtime } = fixture
      transport.exchange.mockResolvedValue(githubToken)
      transport[method].mockRejectedValueOnce(new Error(githubSecrets.upstreamError))
      const flow = await github.start(owner, store.snapshot().revision, false)
      await vi.advanceTimersByTimeAsync(5000)
      const state = github.state(flow.id, owner)
      expect(state.status).toBe("failed")
      expect(state).not.toHaveProperty("userCode")
      expect(runtime.values.readSecret("GH_TOKEN")).toBeUndefined()
      noSecrets([state, github.connection(owner), store.listAudit(0)])
    },
  )

  it.each([2, 1200])(
    "expires without browser status requests at the GitHub or server limit: %s seconds",
    async (seconds) => {
      const { github, owner, store, transport } = fixture
      transport.device.mockResolvedValueOnce({
        deviceCode: githubSecrets.deviceCode,
        userCode: "ABCD-EFGH",
        verificationUri: "https://github.com/login/device",
        expiresIn: seconds,
        interval: 5,
      })
      const flow = await github.start(owner, store.snapshot().revision, false)
      const deadline = Math.min(seconds, 900) * 1000
      expect(flow.expiresAt).toBe(Date.now() + deadline)
      await vi.advanceTimersByTimeAsync(deadline)
      expect(transport.device.mock.calls[0]?.[1].aborted).toBe(true)
      const polls = transport.exchange.mock.calls.length
      await vi.advanceTimersByTimeAsync(10_000)
      expect(transport.exchange).toHaveBeenCalledTimes(polls)
      expect(github.state(flow.id, owner).status).toBe("expired")
    },
  )

  it("bounds an authorized flow by session expiry without extending idle lifetime", async () => {
    const { github, owner, store } = fixture
    const touched = Date.now()
    store.db
      .prepare("UPDATE sessions SET created=?,touched=? WHERE hash=?")
      .run(Date.now() - sessionMaxAgeMs + 7000, touched, owner)
    const flow = await fixture.authorize()
    expect(flow.expiresAt).toBe(touched + 7000)
    expect(store.db.prepare("SELECT touched FROM sessions WHERE hash=?").get(owner)?.touched).toBe(
      touched,
    )
    await vi.advanceTimersByTimeAsync(2000)
    expect(["expired", "cancelled"]).toContain(github.state(flow.id, owner).status)
    expect(fixture.runtime.values.readSecret("GH_TOKEN")).toBeUndefined()
  })

  it("detects session revocation in the background after authorization", async () => {
    const { github, owner, store, session, transport } = fixture
    const flow = await fixture.authorize()
    store.revoke(session.value)
    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.device.mock.calls[0]?.[1].aborted).toBe(true)
    expect(github.state(flow.id, owner).status).toBe("cancelled")
    expect(fixture.runtime.values.readSecret("GH_TOKEN")).toBeUndefined()
  })

  it.each(["exchange", "account"] as const)(
    "awaits cancellation and rejects late success from %s",
    async (method) => {
      const { github, owner, store, transport, runtime } = fixture
      const response = deferred<GitHubToken>()
      const account = deferred<typeof githubAccount>()
      if (method === "exchange") transport.exchange.mockReturnValueOnce(response.promise)
      else {
        transport.exchange.mockResolvedValueOnce(githubToken)
        transport.account.mockReturnValueOnce(account.promise)
      }
      const before = store.snapshot()
      const flow = await github.start(owner, before.revision, false)
      await vi.advanceTimersByTimeAsync(5000)
      let settled = false
      const cancelled = github.cancel(flow.id, owner).then((value) => {
        settled = true
        return value
      })
      await Promise.resolve()
      const settledBeforeResponse = settled
      const aborted = transport.device.mock.calls[0]?.[1].aborted
      response.resolve(githubToken)
      account.resolve(githubAccount)
      expect((await cancelled).status).toBe("cancelled")
      expect(settledBeforeResponse).toBe(false)
      expect(aborted).toBe(true)
      expect(github.state(flow.id, owner)).not.toHaveProperty("userCode")
      expect(runtime.values.readSecret("GH_TOKEN")).toBeUndefined()
      expect(store.snapshot()).toEqual(before)
      if (method === "exchange") expect(transport.account).not.toHaveBeenCalled()
    },
  )

  it("does not accept a device-code response after its owner is revoked", async () => {
    const { github, owner, store, session, transport } = fixture
    const response = deferred<Awaited<ReturnType<typeof transport.device>>>()
    transport.device.mockReturnValueOnce(response.promise)
    const starting = github.start(owner, store.snapshot().revision, false)
    store.revoke(session.value)
    response.resolve({
      deviceCode: githubSecrets.deviceCode,
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      expiresIn: 600,
      interval: 5,
    })
    const flow = await starting
    expect(flow.status).toBe("cancelled")
    expect(flow).not.toHaveProperty("userCode")
    expect(transport.exchange).not.toHaveBeenCalled()
  })

  it("stops pending timers and rejects new work after shutdown", async () => {
    const { github, owner, store, transport } = fixture
    await github.start(owner, store.snapshot().revision, false)
    await github.close()
    expect(transport.device.mock.calls[0]?.[1].aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(transport.exchange).not.toHaveBeenCalled()
    await expect(github.start(owner, store.snapshot().revision, false)).rejects.toMatchObject({
      status: 503,
    })
    await expect(github.resolveToken()).rejects.toMatchObject({ status: 503 })
  })
})

describe("GitHub persistence and completed receipts", () => {
  it("requires explicit replacement consent and leaves the old PAT until Save and apply", async () => {
    const { github, owner, store, runtime, transport } = fixture
    fixture.save("GH_TOKEN", "manual-pat-fixture")
    const before = store.snapshot()
    await expect(github.start(owner, before.revision, false)).rejects.toMatchObject({ status: 409 })
    expect(transport.device).not.toHaveBeenCalled()
    const flow = await fixture.authorize(githubToken, true)
    expect(runtime.readSecret("GH_TOKEN")).toBe("manual-pat-fixture")
    expect(store.snapshot()).toEqual(before)
    await github.cancel(flow.id, owner)
    expect(runtime.readSecret("GH_TOKEN")).toBe("manual-pat-fixture")
    expect(github.connection(owner).mode).toBe("manual")
  })

  it("commits once, applies once, and recovers the same receipt from status, connection, complete, and cancel", async () => {
    const { github, owner, store, runtime, apply } = fixture
    const before = store.snapshot()
    const flow = await fixture.authorize()
    const [first, second] = await Promise.all([
      github.complete(flow.id, owner),
      github.complete(flow.id, owner),
    ])
    expect(first).toEqual(second)
    expect(first).toMatchObject({
      status: "completed",
      account: githubAccount,
      scopes: githubToken.scopes,
      receipt: {
        savedRevision: before.revision + 1,
        application: {
          revision: before.revision + 1,
          applied: before.revision + 1,
          status: "applied",
        },
      },
    })
    expect(store.snapshot()).toMatchObject({
      revision: before.revision + 1,
      epoch: before.epoch + 1,
      policy: before.policy,
    })
    expect(runtime.readSecret("GH_TOKEN")).toBe(githubSecrets.accessToken)
    expect(apply).toHaveBeenCalledOnce()
    const audits = store.listAudit(0)
    expect(github.state(flow.id, owner)).toEqual(first)
    expect(github.connection(owner).flow).toEqual(first)
    expect(await github.cancel(flow.id, owner)).toEqual(first)
    expect(await github.complete(flow.id, owner)).toEqual(first)
    expect(store.listAudit(0)).toEqual(audits)
    noSecrets([first, github.connection(owner), audits])
  })

  it("makes stale revisions terminal and never substitutes the latest settings revision", async () => {
    const { github, owner, store, runtime, apply } = fixture
    const flow = await fixture.authorize()
    fixture.save("UNRELATED", "new revision", "variable")
    const before = store.snapshot()
    const completed = await github.complete(flow.id, owner)
    expect(completed.status).toBe("conflict")
    expect(completed).not.toHaveProperty("receipt")
    expect(runtime.values.readSecret("GH_TOKEN")).toBeUndefined()
    expect(store.snapshot()).toEqual(before)
    expect(apply).not.toHaveBeenCalled()
  })

  it("ignores late exchange success after deleting and recreating the same credential", async () => {
    const { github, owner, store, runtime, transport } = fixture
    fixture.save("GH_TOKEN", "same-manual-pat")
    const response = deferred<GitHubToken>()
    transport.exchange.mockReturnValueOnce(response.promise)
    const flow = await github.start(owner, store.snapshot().revision, true)
    await vi.advanceTimersByTimeAsync(5000)
    runtime.remove("GH_TOKEN", store.snapshot().revision, "42")
    fixture.save("GH_TOKEN", "same-manual-pat")
    github.invalidate()
    response.resolve(githubToken)
    await vi.advanceTimersByTimeAsync(0)
    expect(github.state(flow.id, owner).status).toBe("conflict")
    expect(runtime.readSecret("GH_TOKEN")).toBe("same-manual-pat")
    expect(runtime.values.readSecret("GITHUB_OAUTH_STATE")).toBeUndefined()
    expect(transport.account).not.toHaveBeenCalled()
  })

  it("preserves the previous PAT, revision, and audit on paired-write failure", async () => {
    const { github, owner, runtime, store, apply } = fixture
    fixture.save("GH_TOKEN", "previous-manual-pat")
    const flow = await fixture.authorize(githubToken, true)
    const before = store.snapshot()
    const audit = store.listAudit(0)
    store.db.exec(
      "CREATE TRIGGER reject_github BEFORE INSERT ON runtime_config WHEN NEW.name='GITHUB_OAUTH_STATE' BEGIN SELECT RAISE(ABORT,'github-fixture-private-upstream-error'); END",
    )
    const failed = await github.complete(flow.id, owner)
    expect(failed.status).toBe("failed")
    expect(store.snapshot()).toEqual(before)
    expect(store.listAudit(0)).toEqual(audit)
    expect(runtime.readSecret("GH_TOKEN")).toBe("previous-manual-pat")
    expect(runtime.values.readSecret("GITHUB_OAUTH_STATE")).toBeUndefined()
    expect(await github.complete(flow.id, owner)).toEqual(failed)
    expect(apply).not.toHaveBeenCalled()
    noSecrets(failed)
  })

  it("recovers an exact committed generation after an adapter error without repeating the save", async () => {
    const { github, owner, runtime, apply, transport } = fixture
    const save = runtime.saveGitHub.bind(runtime)
    const saving = vi.spyOn(runtime, "saveGitHub").mockImplementationOnce((...args) => {
      save(...args)
      throw new Error(githubSecrets.upstreamError)
    })
    const flow = await fixture.authorize()
    const completed = await github.complete(flow.id, owner)
    expect(completed).toMatchObject({
      status: "completed",
      receipt: { savedRevision: fixture.store.snapshot().revision },
    })
    expect(await github.complete(flow.id, owner)).toEqual(completed)
    expect(saving).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledOnce()
    expect(transport.exchange).toHaveBeenCalledOnce()
    noSecrets(completed)
  })

  it("keeps a saved receipt when application status reads fail", async () => {
    const { github, owner, store, apply } = fixture
    let restore = () => {}
    apply.mockImplementationOnce(async () => {
      store.applied(store.snapshot().revision, true)
      const reading = vi.spyOn(store, "snapshot").mockImplementation(() => {
        throw new Error(githubSecrets.upstreamError)
      })
      restore = () => reading.mockRestore()
    })
    const flow = await fixture.authorize()
    try {
      const completed = await github.complete(flow.id, owner)
      expect(completed).toMatchObject({
        status: "completed",
        receipt: { application: { status: "unknown" } },
      })
      expect(await github.complete(flow.id, owner)).toEqual(completed)
      expect(await github.cancel(flow.id, owner)).toEqual(completed)
      expect(apply).toHaveBeenCalledOnce()
      noSecrets(completed)
    } finally {
      restore()
    }
  })

  it("retains a committed failed-application receipt after a newer settings revision", async () => {
    const { github, owner, store, runtime, apply, transport } = fixture
    apply.mockRejectedValueOnce(new Error(githubSecrets.upstreamError))
    const flow = await fixture.authorize()
    const completed = await github.complete(flow.id, owner)
    const savedRevision = store.snapshot().revision
    expect(completed).toMatchObject({
      status: "completed",
      receipt: { savedRevision, application: { revision: savedRevision, status: "failed" } },
    })
    expect(runtime.values.readSecret("GH_TOKEN")).toBe(githubSecrets.accessToken)
    expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
    fixture.save("LATER", "pending", "variable", false)
    expect(github.connection(owner)).toMatchObject({
      revision: savedRevision + 1,
      status: "pending",
      flow: completed,
    })
    expect(await github.complete(flow.id, owner)).toEqual(completed)
    expect(await github.cancel(flow.id, owner)).toEqual(completed)
    expect(apply).toHaveBeenCalledOnce()
    expect(transport.exchange).toHaveBeenCalledOnce()
    noSecrets([completed, github.connection(owner), store.listAudit(0)])
  })

  it("reports unknown historical application rather than attributing a newer revision to the receipt", async () => {
    const { github, owner, store, apply } = fixture
    const applying = deferred<void>()
    apply.mockReturnValueOnce(applying.promise)
    const flow = await fixture.authorize()
    const completing = github.complete(flow.id, owner)
    const savedRevision = store.snapshot().revision
    const cancelling = github.cancel(flow.id, owner)
    fixture.save("LATER", "new settings", "variable", false)
    applying.reject(new Error(githubSecrets.upstreamError))
    const completed = await completing
    expect(completed).toMatchObject({
      status: "completed",
      receipt: { savedRevision, application: { revision: savedRevision, status: "unknown" } },
    })
    expect(await cancelling).toEqual(completed)
    expect(github.state(flow.id, owner)).toEqual(completed)
    expect(store.snapshot()).toMatchObject({ revision: savedRevision + 1, status: "pending" })
    expect(apply).toHaveBeenCalledOnce()
  })

  it.each(["cancel", "close"] as const)(
    "keeps committed work tracked until application settles: %s",
    async (action) => {
      const { github, owner, apply } = fixture
      const applying = deferred<void>()
      apply.mockReturnValueOnce(applying.promise)
      const flow = await fixture.authorize()
      const completing = github.complete(flow.id, owner)
      await vi.advanceTimersByTimeAsync(300_001)
      expect(github.state(flow.id, owner)).toMatchObject({
        status: "completed",
        receipt: { savedRevision: fixture.store.snapshot().revision },
      })
      let settled = false
      const waiting = (action === "close" ? github.close() : github.cancel(flow.id, owner)).then(
        () => {
          settled = true
        },
      )
      await Promise.resolve()
      expect(settled).toBe(false)
      applying.resolve()
      await completing
      await waiting
      expect(settled).toBe(true)
      if (action === "cancel") {
        await vi.advanceTimersByTimeAsync(299_999)
        expect(github.state(flow.id, owner).receipt).toBeDefined()
        await vi.advanceTimersByTimeAsync(2)
        expect(() => github.state(flow.id, owner)).toThrow("not found")
      }
    },
  )

  it("returns current safe metadata without replay after completed-receipt eviction or restart", async () => {
    const { github, owner, store, runtime, transport, apply, hasProbe } = fixture
    const completed = await fixture.connect()
    await vi.advanceTimersByTimeAsync(300_001)
    expect(() => github.state(completed.id, owner)).toThrow("not found")
    expect(github.connection(owner)).toMatchObject({
      mode: "oauth",
      account: githubAccount,
      scopes: githubToken.scopes,
    })
    expect(github.connection(owner)).not.toHaveProperty("flow")
    const restarted = new GitHubAuth(store, runtime, transport)
    restarted.configure(apply, hasProbe)
    try {
      expect(() => restarted.state(completed.id, owner)).toThrow("not found")
      expect(restarted.connection(owner)).not.toHaveProperty("flow")
      expect(transport.device).toHaveBeenCalledOnce()
      expect(transport.exchange).toHaveBeenCalledOnce()
      expect(apply).toHaveBeenCalledOnce()
    } finally {
      await restarted.close()
    }
  })

  it("requires an applied public Client ID and a real unexpired session", async () => {
    const { github, owner, store, runtime, transport } = fixture
    runtime.remove("GITHUB_OAUTH_CLIENT_ID", store.snapshot().revision, "42")
    store.applied(store.snapshot().revision, true)
    await expect(github.start(owner, store.snapshot().revision, false)).rejects.toMatchObject({
      status: 409,
    })
    fixture.save("GITHUB_OAUTH_CLIENT_ID", githubClientId, "secret")
    await expect(github.start(owner, store.snapshot().revision, false)).rejects.toMatchObject({
      status: 409,
    })
    runtime.remove("GITHUB_OAUTH_CLIENT_ID", store.snapshot().revision, "42")
    fixture.save("GITHUB_OAUTH_CLIENT_ID", githubClientId, "variable", false)
    await expect(github.start(owner, store.snapshot().revision, false)).rejects.toMatchObject({
      status: 409,
    })
    store.applied(store.snapshot().revision, true)
    await expect(github.start("42", store.snapshot().revision, false)).rejects.toMatchObject({
      status: 401,
    })
    expect(transport.device).not.toHaveBeenCalled()
  })

  it.each([0, 1])(
    "rejects insufficient capacity before any upstream request: %s free slots",
    async (remaining) => {
      const { github, owner, store, runtime, transport } = fixture
      for (let i = 0; i < 255 - remaining; i++)
        runtime.values.setVariable(`FILL_${i}`, "fixture", {
          revision: store.snapshot().revision,
          updatedAt: Date.now(),
        })
      const before = store.snapshot()
      await expect(github.start(owner, before.revision, false)).rejects.toMatchObject({
        status: 400,
      })
      expect(transport.device).not.toHaveBeenCalled()
      expect(store.snapshot()).toEqual(before)
    },
  )

  it("rejects a GH_TOKEN kind conflict before contacting GitHub", async () => {
    const { github, owner, store, transport } = fixture
    fixture.save("GH_TOKEN", "not a secret", "variable")
    await expect(github.start(owner, store.snapshot().revision, true)).rejects.toMatchObject({
      status: 409,
    })
    expect(transport.device).not.toHaveBeenCalled()
  })

  it("rejects locked or unavailable secret storage without contacting GitHub", async () => {
    const { github, owner, store, transport, runtime, apply, hasProbe } = fixture
    fixture.save("OTHER_SECRET", "fixture")
    store.db.prepare("UPDATE runtime_config SET payload='{}' WHERE name='OTHER_SECRET'").run()
    expect(runtime.values.verifySecrets()).toBe(false)
    await expect(github.start(owner, store.snapshot().revision, false)).rejects.toMatchObject({
      status: 503,
    })
    const unavailable = new GitHubAuth(store, new RuntimeConfigAdmin(store), transport)
    unavailable.configure(apply, hasProbe)
    try {
      await expect(
        unavailable.start(owner, store.snapshot().revision, false),
      ).rejects.toMatchObject({ status: 503 })
    } finally {
      await unavailable.close()
    }
    expect(transport.device).not.toHaveBeenCalled()
  })

  it("rechecks secret readiness and the probe interlock immediately before persistence", async () => {
    const { github, owner, store, runtime, hasProbe, transport } = fixture
    hasProbe.mockReturnValue(true)
    await expect(github.start(owner, store.snapshot().revision, false)).rejects.toMatchObject({
      status: 409,
    })
    expect(transport.device).not.toHaveBeenCalled()
    hasProbe.mockReturnValue(false)
    fixture.save("OTHER_SECRET", "fixture")
    const flow = await fixture.authorize()
    hasProbe.mockReturnValue(true)
    await expect(github.complete(flow.id, owner)).rejects.toMatchObject({ status: 409 })
    expect(runtime.values.readSecret("GH_TOKEN")).toBeUndefined()
    hasProbe.mockReturnValue(false)
    store.db.prepare("UPDATE runtime_config SET payload='{}' WHERE name='OTHER_SECRET'").run()
    expect(runtime.values.verifySecrets()).toBe(false)
    await expect(github.complete(flow.id, owner)).rejects.toMatchObject({ status: 503 })
    expect(runtime.values.listMetadata()).not.toContainEqual(
      expect.objectContaining({ name: "GH_TOKEN" }),
    )
  })
})

describe("lazy GitHub token refresh", () => {
  const expiring = { ...githubToken, expiresIn: 30 }

  it("does not refresh manual PATs or non-expiring OAuth tokens", async () => {
    const { github, transport, runtime, store } = fixture
    fixture.save("GH_TOKEN", "manual-pat-fixture")
    expect(await github.resolveToken()).toBe("manual-pat-fixture")
    runtime.remove("GH_TOKEN", store.snapshot().revision, "42")
    store.applied(store.snapshot().revision, true)
    await fixture.connect({ accessToken: githubSecrets.accessToken, scopes: ["repo"] })
    expect(await github.resolveToken()).toBe(githubSecrets.accessToken)
    expect(transport.refresh).not.toHaveBeenCalled()
  })

  it("refreshes only below 60 seconds and keeps the original encrypted Client ID", async () => {
    const { github, transport, store } = fixture
    await fixture.connect({ ...githubToken, expiresIn: 90 })
    expect(await github.resolveToken()).toBe(githubSecrets.accessToken)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await github.resolveToken()).toBe(githubSecrets.accessToken)
    expect(transport.refresh).not.toHaveBeenCalled()
    fixture.save("GITHUB_OAUTH_CLIENT_ID", "different-public-client", "variable")
    const before = store.snapshot()
    await vi.advanceTimersByTimeAsync(1)
    expect(await github.resolveToken()).toBe(githubSecrets.rotatedAccessToken)
    expect(transport.refresh).toHaveBeenCalledWith(
      githubClientId,
      githubSecrets.refreshToken,
      expect.any(AbortSignal),
    )
    expect(store.snapshot()).toEqual(before)
  })

  it("coalesces concurrent refreshes, writes a durable marker first, and does not apply or change the policy epoch", async () => {
    const { github, runtime, transport, store, apply } = fixture
    await fixture.connect(expiring)
    const before = store.snapshot()
    const applying = apply.mock.calls.length
    const response = deferred<GitHubToken>()
    transport.refresh.mockReturnValueOnce(response.promise)
    const first = github.resolveToken()
    const second = github.resolveToken()
    const refreshCount = transport.refresh.mock.calls.length
    const marked = runtime.githubCredentials()
    const tokenDuringRefresh = runtime.readSecret("GH_TOKEN")
    response.resolve({
      ...githubToken,
      accessToken: githubSecrets.rotatedAccessToken,
      refreshToken: githubSecrets.rotatedRefreshToken,
    })
    expect(await Promise.all([first, second])).toEqual([
      githubSecrets.rotatedAccessToken,
      githubSecrets.rotatedAccessToken,
    ])
    expect(refreshCount).toBe(1)
    expect(marked).toMatchObject({
      kind: "oauth",
      state: { rotation: 0, attempt: expect.any(String) },
    })
    expect(tokenDuringRefresh).toBeUndefined()
    expect(runtime.githubCredentials()).toMatchObject({
      kind: "oauth",
      state: { rotation: 1, refreshToken: githubSecrets.rotatedRefreshToken },
    })
    const rotated = runtime.githubCredentials()
    if (rotated.kind !== "oauth") throw new Error("Expected managed OAuth state")
    expect(rotated.state.attempt).toBeUndefined()
    expect(store.snapshot()).toEqual(before)
    expect(apply).toHaveBeenCalledTimes(applying)
    expect(store.listAudit(0).map((entry) => entry.operation)).toEqual(
      expect.arrayContaining(["github.refresh.started", "github.refresh.completed"]),
    )
    noSecrets([github.connection(fixture.owner), runtime.snapshot(), store.listAudit(0)])
  })

  it.each([
    new Error(githubSecrets.upstreamError),
    new DOMException(githubSecrets.upstreamError, "TimeoutError"),
  ])("fails closed after refresh rejection or timeout: %s", async (failure) => {
    const { github, runtime, transport, owner, store } = fixture
    await fixture.connect(expiring)
    transport.refresh.mockRejectedValueOnce(failure)
    await expect(github.resolveToken()).rejects.toMatchObject({ status: 409 })
    expect(runtime.values.readSecret("GH_TOKEN")).toBe(githubSecrets.accessToken)
    expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
    expect(github.connection(owner)).toMatchObject({ mode: "oauth", reconnectRequired: true })
    await expect(github.resolveToken()).rejects.toMatchObject({ status: 409 })
    expect(transport.refresh).toHaveBeenCalledOnce()
    noSecrets([github.connection(owner), store.listAudit(0)])
  })

  it.each([
    { ...expiring, refreshToken: undefined, refreshExpiresIn: undefined },
    { ...expiring, expiresIn: 3600, refreshToken: undefined, refreshExpiresIn: undefined },
    { ...expiring, expiresIn: 3600, refreshExpiresIn: 1 },
    { ...expiring, refreshExpiresIn: 1 },
  ])("does not use missing or expired refresh credentials", async (token) => {
    const { github, transport, runtime, owner } = fixture
    await fixture.connect(token)
    await vi.advanceTimersByTimeAsync(31_000)
    await expect(github.resolveToken()).rejects.toMatchObject({ status: 409 })
    expect(transport.refresh).not.toHaveBeenCalled()
    expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
    expect(github.connection(owner).reconnectRequired).toBe(true)
  })

  it("does not send a refresh request when the attempt marker cannot commit", async () => {
    const { github, runtime, store, transport } = fixture
    await fixture.connect(expiring)
    const before = store.snapshot()
    const audit = store.listAudit(0)
    store.db.exec(
      "CREATE TRIGGER reject_marker BEFORE INSERT ON runtime_config WHEN NEW.name='GITHUB_OAUTH_STATE' BEGIN SELECT RAISE(ABORT,'github-fixture-private-upstream-error'); END",
    )
    await expect(github.resolveToken()).rejects.toBeDefined()
    expect(transport.refresh).not.toHaveBeenCalled()
    expect(store.snapshot()).toEqual(before)
    expect(store.listAudit(0)).toEqual(audit)
    const pair = runtime.githubCredentials()
    if (pair.kind !== "oauth") throw new Error("Expected managed OAuth state")
    expect(pair.state.attempt).toBeUndefined()
  })

  it("requires reconnect after restart with an unresolved attempt, without repeating the exchange", async () => {
    const { github, runtime, store, transport, owner, apply, hasProbe } = fixture
    await fixture.connect(expiring)
    const pair = runtime.githubCredentials()
    if (pair.kind !== "oauth") throw new Error("Expected managed OAuth state")
    expect(
      runtime.rotateGitHub(
        pair,
        pair.token,
        { ...pair.state, attempt: "crashed-fixture-attempt" },
        "started",
      ),
    ).toBe(true)
    await github.close()
    const restarted = new GitHubAuth(store, runtime, transport)
    restarted.configure(apply, hasProbe)
    try {
      expect(restarted.connection(owner)).toMatchObject({ mode: "oauth", reconnectRequired: true })
      await expect(restarted.resolveToken()).rejects.toMatchObject({ status: 409 })
      expect(transport.refresh).not.toHaveBeenCalled()
      expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
      noSecrets(restarted.connection(owner))
    } finally {
      await restarted.close()
    }
  })

  it("keeps an uncertain successful rotation unavailable when persistence and failure marking both fail", async () => {
    const { github, transport, runtime, store, owner } = fixture
    await fixture.connect(expiring)
    const response = deferred<GitHubToken>()
    transport.refresh.mockReturnValueOnce(response.promise)
    const resolving = github.resolveToken().catch((error: unknown) => error)
    store.db.exec(
      "CREATE TRIGGER reject_rotation BEFORE INSERT ON runtime_config WHEN NEW.name='GITHUB_OAUTH_STATE' BEGIN SELECT RAISE(ABORT,'github-fixture-private-upstream-error'); END",
    )
    response.resolve({ ...githubToken, accessToken: githubSecrets.rotatedAccessToken })
    expect(await resolving).toMatchObject({ status: 409 })
    expect(runtime.values.readSecret("GH_TOKEN")).toBe(githubSecrets.accessToken)
    expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
    expect(github.connection(owner).reconnectRequired).toBe(true)
    await expect(github.resolveToken()).rejects.toMatchObject({ status: 409 })
    expect(transport.refresh).toHaveBeenCalledOnce()
  })

  it.each(["success", "failure"])(
    "does not let a late refresh %s invalidate a replacement PAT",
    async (outcome) => {
      const { github, transport, runtime, owner } = fixture
      await fixture.connect(expiring)
      const response = deferred<GitHubToken>()
      transport.refresh.mockReturnValueOnce(response.promise)
      const resolving = github.resolveToken().catch((error: unknown) => error)
      fixture.save("GH_TOKEN", "new-manual-pat")
      github.invalidate()
      const aborted = transport.refresh.mock.calls[0]?.[2].aborted
      if (outcome === "success")
        response.resolve({ ...githubToken, accessToken: githubSecrets.rotatedAccessToken })
      else response.reject(new Error(githubSecrets.upstreamError))
      await resolving
      expect(aborted).toBe(true)
      expect(await github.resolveToken()).toBe("new-manual-pat")
      expect(runtime.values.readSecret("GITHUB_OAUTH_STATE")).toBeUndefined()
      expect(github.connection(owner)).toMatchObject({ mode: "manual", reconnectRequired: false })
    },
  )

  it("cannot restore a credential deleted during a refresh", async () => {
    const { github, transport, runtime, store, owner } = fixture
    await fixture.connect(expiring)
    const response = deferred<GitHubToken>()
    transport.refresh.mockReturnValueOnce(response.promise)
    const resolving = github.resolveToken().catch((error: unknown) => error)
    runtime.remove("GH_TOKEN", store.snapshot().revision, "42")
    store.applied(store.snapshot().revision, true)
    github.invalidate()
    response.resolve({ ...githubToken, accessToken: githubSecrets.rotatedAccessToken })
    await resolving
    expect(await github.resolveToken()).toBeUndefined()
    expect(runtime.values.readSecret("GH_TOKEN")).toBeUndefined()
    expect(runtime.values.readSecret("GITHUB_OAUTH_STATE")).toBeUndefined()
    expect(github.connection(owner)).toMatchObject({ mode: "none", reconnectRequired: false })
  })

  it.each(["pending", "failed"])(
    "preserves the global %s application gate before and after refresh",
    async (status) => {
      const { github, transport, runtime, store } = fixture
      await fixture.connect(expiring)
      fixture.save("UNRELATED", "pending variable", "variable", false)
      if (status === "failed") store.applied(store.snapshot().revision, false)
      await expect(github.resolveToken()).rejects.toMatchObject({ status: 409 })
      expect(transport.refresh).not.toHaveBeenCalled()
      expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
      store.applied(store.snapshot().revision, true)
      const response = deferred<GitHubToken>()
      transport.refresh.mockReturnValueOnce(response.promise)
      const resolving = github.resolveToken().catch((error: unknown) => error)
      fixture.save("ANOTHER", "pending again", "variable", false)
      if (status === "failed") store.applied(store.snapshot().revision, false)
      response.resolve({ ...githubToken, accessToken: githubSecrets.rotatedAccessToken })
      expect(await resolving).toMatchObject({ status: 409 })
      expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
      store.applied(store.snapshot().revision, true)
      expect(await github.resolveToken()).toBe(githubSecrets.rotatedAccessToken)
    },
  )

  it("lets an aborted caller leave a shared refresh without cancelling other callers", async () => {
    const { github, transport } = fixture
    await fixture.connect(expiring)
    const response = deferred<GitHubToken>()
    transport.refresh.mockReturnValueOnce(response.promise)
    const controller = new AbortController()
    let cancelledEarly = false
    const first = github
      .resolveToken(controller.signal)
      .catch((error: unknown) => error)
      .finally(() => {
        cancelledEarly = true
      })
    const second = github.resolveToken()
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    const exitedBeforeResponse = cancelledEarly
    const aborted = transport.refresh.mock.calls[0]?.[2].aborted
    response.resolve({ ...githubToken, accessToken: githubSecrets.rotatedAccessToken })
    expect(await second).toBe(githubSecrets.rotatedAccessToken)
    expect(await first).toMatchObject({ status: 409 })
    expect(exitedBeforeResponse).toBe(true)
    expect(aborted).toBe(false)
    expect(transport.refresh).toHaveBeenCalledOnce()
  })

  it("rejects an invalid managed pair rather than treating its token as a manual PAT", async () => {
    const { github, runtime, store, owner, transport } = fixture
    await fixture.connect(expiring)
    runtime.values.setSecret("GH_TOKEN", "unmatched-token", {
      revision: store.snapshot().revision,
      updatedAt: Date.now(),
    })
    expect(github.connection(owner)).toMatchObject({ mode: "invalid", reconnectRequired: true })
    await expect(github.resolveToken()).rejects.toMatchObject({ status: 409 })
    expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
    expect(transport.refresh).not.toHaveBeenCalled()
  })
})
