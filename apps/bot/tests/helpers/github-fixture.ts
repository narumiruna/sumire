import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { vi } from "vitest"
import { GitHubAuth } from "../../src/admin/github-auth.js"
import { RuntimeConfigAdmin } from "../../src/admin/runtime-config.js"
import { AdminStore, digest } from "../../src/admin/store.js"
import type { GitHubToken, GitHubTransport } from "../../src/github-client.js"

export const githubSecrets = {
  deviceCode: "github-fixture-device-secret",
  accessToken: "github-fixture-access-secret",
  refreshToken: "github-fixture-refresh-secret",
  rotatedAccessToken: "github-fixture-rotated-access-secret",
  rotatedRefreshToken: "github-fixture-rotated-refresh-secret",
  upstreamError: "github-fixture-private-upstream-error",
}
export const githubClientId = "Iv1-fixture-client"
export const githubAccount = { id: 1234, login: "fixture-account" }
export const githubToken: GitHubToken = {
  accessToken: githubSecrets.accessToken,
  scopes: ["repo", "read:org"],
  expiresIn: 3600,
  refreshToken: githubSecrets.refreshToken,
  refreshExpiresIn: 86400,
}

export function deferred<T>() {
  let resolve = (_value: T) => {}
  let reject = (_error: unknown) => {}
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

export function createGitHubFixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sumire-github-"))
  const key = randomBytes(32).toString("base64")
  const store = new AdminStore(path.join(directory, "admin.sqlite"), 42)
  store.applied(1, true)
  const session = store.createSession("42")
  const owner = digest(session.value)
  const runtime = new RuntimeConfigAdmin(store, key)
  const save = (
    name: string,
    value: string,
    kind: "secret" | "variable" = "secret",
    apply = true,
  ) => {
    runtime.save(name, { revision: store.snapshot().revision, kind, value }, "42")
    if (apply) store.applied(store.snapshot().revision, true)
  }
  save("GITHUB_OAUTH_CLIENT_ID", githubClientId, "variable")
  const transport = {
    device: vi.fn<GitHubTransport["device"]>().mockResolvedValue({
      deviceCode: githubSecrets.deviceCode,
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      expiresIn: 600,
      interval: 5,
    }),
    exchange: vi
      .fn<GitHubTransport["exchange"]>()
      .mockResolvedValue({ error: "authorization_pending" }),
    refresh: vi.fn<GitHubTransport["refresh"]>().mockResolvedValue({
      ...githubToken,
      accessToken: githubSecrets.rotatedAccessToken,
      refreshToken: githubSecrets.rotatedRefreshToken,
    }),
    account: vi.fn<GitHubTransport["account"]>().mockResolvedValue(githubAccount),
  } satisfies GitHubTransport
  const apply = vi.fn(async () => {
    store.applied(store.snapshot().revision, true)
  })
  const hasProbe = vi.fn(() => false)
  const github = new GitHubAuth(store, runtime, transport)
  github.configure(apply, hasProbe)
  const authorize = async (token: GitHubToken = githubToken, replace = false) => {
    transport.exchange.mockResolvedValueOnce(token)
    const flow = await github.start(owner, store.snapshot().revision, replace)
    await vi.advanceTimersByTimeAsync(5000)
    return github.state(flow.id, owner)
  }
  const connect = async (token: GitHubToken = githubToken, replace = false) => {
    const flow = await authorize(token, replace)
    return github.complete(flow.id, owner)
  }
  return {
    directory,
    key,
    store,
    session,
    owner,
    runtime,
    transport,
    apply,
    hasProbe,
    github,
    save,
    authorize,
    connect,
    async close() {
      await github.close()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    },
  }
}

export type GitHubFixture = ReturnType<typeof createGitHubFixture>
