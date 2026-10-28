import { randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { RuntimeConfigStore } from "@narumitw/sumire-runtime-config"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  type GitHubCredentials,
  type GitHubPair,
  githubAccessDigest,
  githubStateName,
  parseGitHubCredentials,
} from "../src/admin/github-state.js"
import { McpAdmin } from "../src/admin/mcp.js"
import { RuntimeConfigAdmin } from "../src/admin/runtime-config.js"
import { AdminStore } from "../src/admin/store.js"

const key = randomBytes(32).toString("base64")
const accessToken = "synthetic-github-access-token"
const refreshToken = "synthetic-github-refresh-token"
const nextToken = "synthetic-github-rotated-access-token"
let directory: string
let store: AdminStore
let runtime: RuntimeConfigAdmin

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), "sumire-github-storage-"))
  store = new AdminStore(path.join(directory, "admin.sqlite"), 42)
  store.applied(1, true)
  runtime = new RuntimeConfigAdmin(store, key)
})
afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

function credentials(
  token = accessToken,
  changes: Partial<GitHubCredentials> = {},
): GitHubCredentials {
  return {
    version: 1,
    generation: "synthetic-generation",
    rotation: 0,
    clientId: "synthetic-client-id",
    account: { id: 123, login: "synthetic-account" },
    scopes: ["repo", "read:org"],
    accessDigest: githubAccessDigest(token),
    expiresAt: Date.now() + 3_600_000,
    refreshToken,
    refreshExpiresAt: Date.now() + 86_400_000,
    ...changes,
  }
}
function save(token = accessToken, state = credentials(token)): void {
  runtime.saveGitHub(token, state, store.snapshot().revision, "42")
}
function apply(): void {
  store.applied(store.snapshot().revision, true)
}
function pair(): GitHubPair {
  const stored = runtime.githubCredentials()
  expect(stored.kind).toBe("oauth")
  if (stored.kind !== "oauth") throw new Error("Expected synthetic OAuth credentials")
  return { token: stored.token, state: stored.state }
}
function start(attempt = "synthetic-attempt"): GitHubPair {
  const current = pair()
  expect(
    runtime.rotateGitHub(current, current.token, { ...current.state, attempt }, "started"),
  ).toBe(true)
  return pair()
}
function completed(expected: GitHubPair, token = nextToken): GitHubCredentials {
  return {
    ...expected.state,
    rotation: expected.state.rotation + 1,
    accessDigest: githubAccessDigest(token),
    expiresAt: Date.now() + 7_200_000,
    refreshToken: "synthetic-rotated-refresh-token",
    attempt: undefined,
    reconnectRequired: undefined,
  }
}
function failed(expected: GitHubPair): GitHubCredentials {
  return { ...expected.state, attempt: undefined, reconnectRequired: true }
}
function persisted() {
  return {
    settings: store.snapshot(),
    rows: store.db.prepare("SELECT * FROM runtime_config ORDER BY name").all(),
    audit: store.listAudit(0),
  }
}
function restart(master = key): void {
  const file = store.file
  store.close()
  store = new AdminStore(file, 42)
  runtime = new RuntimeConfigAdmin(store, master)
}
function manual(token = accessToken): void {
  runtime.save(
    "GH_TOKEN",
    { revision: store.snapshot().revision, kind: "secret", value: token },
    "42",
  )
}
/** Seed pre-upgrade/corrupt fixtures through the low-level store, never production mutation paths. */
function legacyState(value: string, kind: "secret" | "variable" = "secret"): void {
  const legacy = new RuntimeConfigStore(store.db, key)
  const metadata = { revision: store.snapshot().revision, updatedAt: Date.now() }
  if (kind === "secret") legacy.setSecret(githubStateName, value, metadata)
  else legacy.setVariable(githubStateName, value, metadata)
}
function fill(count: number): void {
  for (let n = 0; n < count; n++)
    runtime.save(
      `FIXTURE_${n}`,
      { revision: store.snapshot().revision, kind: "variable", value: "" },
      "42",
    )
}

// Only synthetic credentials are used. No test sends an upstream request.
describe("GitHub paired credential persistence", () => {
  it("saves one encrypted pair with one revision, epoch and fixed audit event", () => {
    const before = store.snapshot()
    const state = credentials()
    const audits = store.listAudit(0).length
    save(accessToken, state)
    expect(store.snapshot()).toEqual({
      ...before,
      revision: before.revision + 1,
      epoch: before.epoch + 1,
      status: "pending",
    })
    expect(runtime.githubCredentials()).toEqual({ kind: "oauth", token: accessToken, state })
    expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
    expect(runtime.snapshot().entries).toEqual([
      expect.objectContaining({ name: "GH_TOKEN", kind: "secret", revision: before.revision + 1 }),
    ])
    expect(store.listAudit(0)).toHaveLength(audits + 1)
    expect(store.listAudit(0)[0]).toMatchObject({
      actor: "42",
      operation: "github.connect",
      revision: before.revision + 1,
      outcome: "saved",
      target: "GH_TOKEN",
    })
    const rows = store.db.prepare("SELECT * FROM runtime_config ORDER BY name").all()
    expect(rows).toHaveLength(2)
    for (const row of rows)
      expect(row).toMatchObject({ kind: "secret", revision: before.revision + 1 })
    for (const value of [
      accessToken,
      refreshToken,
      state.accessDigest,
      state.generation,
      state.clientId,
    ]) {
      expect(JSON.stringify(rows)).not.toContain(value)
      expect(JSON.stringify(runtime.snapshot())).not.toContain(value)
      expect(JSON.stringify(store.listAudit(0))).not.toContain(value)
      expect(readFileSync(store.file).includes(Buffer.from(value))).toBe(false)
    }
    apply()
    expect(runtime.readSecret("GH_TOKEN")).toBe(accessToken)
    const saved = persisted()
    restart()
    expect(persisted()).toEqual(saved)
    expect(runtime.githubCredentials()).toEqual({ kind: "oauth", token: accessToken, state })
    expect(store.db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 4 })
  })

  it("preserves normal manual PATs only when the companion is absent", () => {
    expect(runtime.githubCredentials()).toEqual({ kind: "none" })
    manual()
    expect(runtime.githubCredentials()).toEqual({ kind: "manual", token: accessToken })
    expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
    apply()
    expect(runtime.readSecret("GH_TOKEN")).toBe(accessToken)
    restart()
    expect(runtime.githubCredentials()).toEqual({ kind: "manual", token: accessToken })
    runtime.remove("GH_TOKEN", store.snapshot().revision, "42")
    expect(runtime.githubCredentials()).toEqual({ kind: "none" })
  })

  it("allows legacy non-expiring OAuth without refresh metadata", () => {
    save(
      accessToken,
      credentials(accessToken, {
        expiresAt: undefined,
        refreshToken: undefined,
        refreshExpiresAt: undefined,
      }),
    )
    apply()
    expect(runtime.readSecret("GH_TOKEN")).toBe(accessToken)
    expect(pair().state).not.toHaveProperty("refreshToken")
  })

  it("rejects stale connect and disconnect writes without changing any persisted data", () => {
    const stale = store.snapshot().revision
    save()
    const before = persisted()
    expect(() => runtime.saveGitHub(nextToken, credentials(nextToken), stale, "42")).toThrow(
      "Settings changed",
    )
    expect(() => runtime.disconnectGitHub(stale, "42")).toThrow("Settings changed")
    expect(persisted()).toEqual(before)
  })

  it.each([
    [
      "digest mismatch",
      (state: GitHubCredentials) => ({ ...state, accessDigest: githubAccessDigest("different") }),
    ],
    ["malformed metadata", (state: GitHubCredentials) => ({ ...state, rotation: -1 })],
    [
      "oversized serialized state",
      (state: GitHubCredentials) => ({ ...state, refreshToken: "x".repeat(8192) }),
    ],
  ] as const)("rejects a %s atomically", (_name, mutate) => {
    manual()
    const before = persisted()
    expect(() => save(nextToken, mutate(credentials(nextToken)))).toThrow("Invalid runtime")
    expect(persisted()).toEqual(before)
  })

  it("uses existing token byte and UTF-8 limits", () => {
    const before = persisted()
    for (const token of ["", "x".repeat(8193), "終".repeat(2731), "\ud800"])
      expect(() => save(token)).toThrow("Invalid runtime")
    expect(persisted()).toEqual(before)
  })

  it.each(["manual", "oauth"])(
    "rolls back the first paired write and audit if the second write fails over %s",
    (mode) => {
      if (mode === "manual") manual()
      else save()
      const before = persisted()
      store.db.exec(`CREATE TRIGGER reject_github_state BEFORE INSERT ON runtime_config
      WHEN NEW.name='GITHUB_OAUTH_STATE' BEGIN SELECT RAISE(ABORT,'fixture'); END`)
      expect(() =>
        save(nextToken, credentials(nextToken, { generation: "new-generation" })),
      ).toThrow("fixture")
      expect(persisted()).toEqual(before)
    },
  )

  it("rolls back a new token when only one of the two required capacity slots is available", () => {
    fill(255)
    const before = persisted()
    expect(() => save()).toThrow("256")
    expect(persisted()).toEqual(before)
    expect(runtime.githubCredentials()).toEqual({ kind: "none" })
  })

  it("uses both final slots and permits pair rotation and manual replacement at capacity", () => {
    fill(254)
    save()
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM runtime_config").get()?.n).toBe(256)
    const attempt = start()
    expect(runtime.rotateGitHub(attempt, nextToken, completed(attempt), "completed")).toBe(true)
    manual(nextToken)
    expect(runtime.githubCredentials()).toEqual({ kind: "manual", token: nextToken })
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM runtime_config").get()?.n).toBe(255)
  })

  it.each(["same-token", "new-token", "delete"])(
    "clears managed state on generic %s in one normal revision",
    (operation) => {
      save()
      const attempt = start()
      const before = store.snapshot()
      const audits = store.listAudit(0).length
      if (operation === "delete") runtime.remove("GH_TOKEN", before.revision, "42")
      else manual(operation === "same-token" ? accessToken : nextToken)
      expect(store.snapshot()).toMatchObject({
        revision: before.revision + 1,
        epoch: before.epoch + 1,
        status: "pending",
      })
      expect(store.listAudit(0)).toHaveLength(audits + 1)
      expect(
        store.db.prepare("SELECT name FROM runtime_config WHERE name=?").get(githubStateName),
      ).toBeUndefined()
      const saved = persisted()
      expect(runtime.rotateGitHub(attempt, nextToken, completed(attempt), "completed")).toBe(false)
      expect(runtime.rotateGitHub(attempt, attempt.token, failed(attempt), "failed")).toBe(false)
      expect(persisted()).toEqual(saved)
      expect(runtime.githubCredentials()).toEqual(
        operation === "delete"
          ? { kind: "none" }
          : { kind: "manual", token: operation === "same-token" ? accessToken : nextToken },
      )
    },
  )

  it.each(["replace", "delete", "disconnect"])(
    "rolls back %s if companion deletion fails",
    (operation) => {
      save()
      const before = persisted()
      store.db.exec(`CREATE TRIGGER reject_github_delete BEFORE DELETE ON runtime_config
      WHEN OLD.name='GITHUB_OAUTH_STATE' BEGIN SELECT RAISE(ABORT,'fixture'); END`)
      expect(() => {
        if (operation === "replace") manual(nextToken)
        else if (operation === "delete") runtime.remove("GH_TOKEN", store.snapshot().revision, "42")
        else runtime.disconnectGitHub(store.snapshot().revision, "42")
      }).toThrow("fixture")
      expect(persisted()).toEqual(before)
    },
  )
})

describe("GitHub internal state protection and recovery", () => {
  it.each(["secret", "variable"] as const)(
    "blocks generic reads, mutations and MCP resolution of %s state",
    (kind) => {
      if (kind === "secret") save()
      else legacyState("legacy-state-variable-sentinel", kind)
      apply()
      const before = persisted()
      expect(runtime.readSecret(githubStateName)).toBeUndefined()
      expect(runtime.readVariable(githubStateName)).toBeUndefined()
      expect(runtime.snapshot().entries.some((entry) => entry.name === githubStateName)).toBe(false)
      expect(JSON.stringify(runtime.snapshot())).not.toContain("legacy-state-variable-sentinel")
      for (const mutationKind of ["secret", "variable"] as const)
        expect(() =>
          runtime.save(
            githubStateName,
            { revision: store.snapshot().revision, kind: mutationKind, value: "overwrite" },
            "42",
          ),
        ).toThrow("server-owned")
      expect(() => runtime.remove(githubStateName, store.snapshot().revision, "42")).toThrow(
        "server-owned",
      )
      expect(persisted()).toEqual(before)
      const mcp = new McpAdmin(store, directory, runtime)
      mcp.save(
        "fixture",
        { command: "fixture", env: { STATE: `\${${githubStateName}}` } },
        store.snapshot().revision,
        "42",
      )
      apply()
      expect(mcp.config().servers).toEqual([])
    },
  )

  it.each([
    ["malformed JSON", "{"],
    ["null", "null"],
    ["array", "[]"],
    ["unknown schema version", JSON.stringify(credentials(accessToken, { version: 2 as 1 }))],
    ["invalid rotation", JSON.stringify(credentials(accessToken, { rotation: -1 }))],
    ["wrong account kind", JSON.stringify({ ...credentials(), account: "account" })],
    ["unknown fields", JSON.stringify({ ...credentials(), unrelated: true })],
    ["mismatched digest", JSON.stringify(credentials(nextToken))],
  ])("fails closed on %s without reinterpreting OAuth as a PAT", (_name, payload) => {
    save()
    legacyState(payload)
    apply()
    expect(runtime.githubCredentials()).toEqual({ kind: "invalid" })
    expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
    const before = persisted()
    expect(() => save(nextToken)).toThrow("explicitly disconnect")
    expect(() => manual()).toThrow("explicitly disconnect")
    expect(() => runtime.remove("GH_TOKEN", store.snapshot().revision, "42")).toThrow(
      "explicitly disconnect",
    )
    expect(persisted()).toEqual(before)
    restart()
    expect(runtime.githubCredentials()).toEqual({ kind: "invalid" })
    expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
    runtime.disconnectGitHub(store.snapshot().revision, "42")
    expect(runtime.githubCredentials()).toEqual({ kind: "none" })
  })

  it("does not overwrite a legacy variable collision when saving or manually replacing GH_TOKEN", () => {
    manual()
    legacyState("unrelated-legacy-collision", "variable")
    apply()
    const before = persisted()
    expect(runtime.githubCredentials()).toEqual({ kind: "invalid" })
    expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
    expect(() => save(nextToken)).toThrow("explicitly disconnect")
    expect(() => manual(nextToken)).toThrow("explicitly disconnect")
    expect(() => runtime.remove("GH_TOKEN", store.snapshot().revision, "42")).toThrow(
      "explicitly disconnect",
    )
    expect(persisted()).toEqual(before)
    runtime.disconnectGitHub(store.snapshot().revision, "42")
    expect(runtime.githubCredentials()).toEqual({ kind: "none" })
    expect(store.snapshot()).toMatchObject({
      revision: before.settings.revision + 1,
      epoch: before.settings.epoch + 1,
      status: "pending",
    })
    expect(store.listAudit(0)[0]).toMatchObject({
      actor: "42",
      operation: "github.disconnect",
      target: "GH_TOKEN,GITHUB_OAUTH_STATE",
    })
    expect(JSON.stringify(store.listAudit(0))).not.toContain("unrelated-legacy-collision")
    save(nextToken)
    expect(pair().token).toBe(nextToken)
  })

  it.each(["secret", "variable"] as const)(
    "explicitly resets an orphaned %s companion when GH_TOKEN is absent",
    (kind) => {
      legacyState(kind === "secret" ? JSON.stringify(credentials()) : "legacy-collision", kind)
      expect(runtime.githubCredentials()).toEqual({ kind: "invalid" })
      const before = persisted()
      expect(() => manual()).toThrow("explicitly disconnect")
      expect(() => save()).toThrow("explicitly disconnect")
      expect(persisted()).toEqual(before)
      runtime.disconnectGitHub(store.snapshot().revision, "42")
      expect(runtime.githubCredentials()).toEqual({ kind: "none" })
      expect(store.snapshot().revision).toBe(before.settings.revision + 1)
      expect(store.listAudit(0)).toHaveLength(before.audit.length + 1)
    },
  )

  it("treats a variable-kind GH_TOKEN as invalid and permits explicit collision reset", () => {
    runtime.save("GH_TOKEN", { revision: 1, kind: "variable", value: "unrelated-literal" }, "42")
    expect(runtime.githubCredentials()).toEqual({ kind: "invalid" })
    const before = persisted()
    expect(() => save()).toThrow("explicitly disconnect")
    expect(persisted()).toEqual(before)
    runtime.disconnectGitHub(store.snapshot().revision, "42")
    expect(runtime.githubCredentials()).toEqual({ kind: "none" })
  })

  it("does not mutate settings when both reset entries are absent", () => {
    const before = persisted()
    expect(() => runtime.disconnectGitHub(store.snapshot().revision, "42")).toThrow("not found")
    expect(persisted()).toEqual(before)
  })

  it.each(["unavailable", "locked"])(
    "fails closed and rolls back encrypted mutations when storage is %s",
    (status) => {
      save()
      apply()
      const current = pair()
      runtime = new RuntimeConfigAdmin(
        store,
        status === "unavailable" ? undefined : randomBytes(32).toString("base64"),
      )
      expect(runtime.snapshot().secretStatus).toBe(status)
      expect(runtime.githubCredentials()).toEqual({ kind: "invalid" })
      expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
      const before = persisted()
      for (const action of [
        () => save(nextToken),
        () => runtime.disconnectGitHub(store.snapshot().revision, "42"),
        () => manual(nextToken),
        () => runtime.remove("GH_TOKEN", store.snapshot().revision, "42"),
        () =>
          runtime.rotateGitHub(
            current,
            current.token,
            { ...current.state, attempt: "new-attempt" },
            "started",
          ),
      ]) {
        expect(action).toThrow(status)
        expect(persisted()).toEqual(before)
      }
    },
  )

  it("does not partially save a first connection without a key", () => {
    runtime = new RuntimeConfigAdmin(store)
    const before = persisted()
    expect(() => save()).toThrow("unavailable")
    expect(persisted()).toEqual(before)
    expect(runtime.githubCredentials()).toEqual({ kind: "none" })
  })

  it("locks on corrupted ciphertext instead of returning a manual credential", () => {
    save()
    apply()
    store.db.prepare("UPDATE runtime_config SET payload='{}' WHERE name=?").run(githubStateName)
    expect(runtime.githubCredentials()).toEqual({ kind: "invalid" })
    expect(runtime.snapshot().secretStatus).toBe("locked")
    expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
    const before = persisted()
    expect(() => runtime.disconnectGitHub(store.snapshot().revision, "42")).toThrow("locked")
    expect(persisted()).toEqual(before)
  })
})

describe("GitHub same-generation compare-and-swap rotation", () => {
  it("records and completes an encrypted attempt without settings revision, epoch or application changes", () => {
    save()
    apply()
    const before = store.snapshot()
    const accessRevision = runtime.snapshot().entries[0]?.revision
    const originalRows = persisted().rows
    const attempt = start()
    expect(store.snapshot()).toEqual(before)
    expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
    expect(persisted().rows).not.toEqual(originalRows)
    expect(JSON.stringify(persisted().rows)).not.toContain(attempt.state.attempt)
    expect(runtime.rotateGitHub(attempt, nextToken, completed(attempt), "completed")).toBe(true)
    expect(store.snapshot()).toEqual(before)
    expect(runtime.snapshot().entries[0]?.revision).toBe(accessRevision)
    expect(runtime.readSecret("GH_TOKEN")).toBe(nextToken)
    expect(pair().state).toMatchObject({ rotation: 1, accessDigest: githubAccessDigest(nextToken) })
    expect(pair().state).not.toHaveProperty("attempt")
    expect(pair().state).not.toHaveProperty("reconnectRequired")
    const events = store
      .listAudit(0)
      .filter((entry) => entry.operation.startsWith("github.refresh."))
    expect(events.map((entry) => entry.operation)).toEqual([
      "github.refresh.completed",
      "github.refresh.started",
    ])
    for (const event of events)
      expect(event).toMatchObject({
        actor: "system",
        target: "GH_TOKEN",
        outcome: "saved",
        revision: before.revision,
      })
    for (const value of [
      accessToken,
      nextToken,
      refreshToken,
      attempt.state.attempt,
      attempt.state.accessDigest,
    ])
      expect(JSON.stringify(events)).not.toContain(value)
  })

  it.each(["pending", "failed"])(
    "can persist unchanged credentials under unrelated %s settings without opening the applied gate",
    (status) => {
      save()
      apply()
      runtime.save(
        "UNRELATED",
        { revision: store.snapshot().revision, kind: "variable", value: "pending" },
        "42",
      )
      if (status === "failed") store.applied(store.snapshot().revision, false)
      const before = store.snapshot()
      const attempt = start()
      expect(runtime.rotateGitHub(attempt, nextToken, completed(attempt), "completed")).toBe(true)
      expect(store.snapshot()).toEqual(before)
      expect(pair().token).toBe(nextToken)
      expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
      apply()
      expect(runtime.readSecret("GH_TOKEN")).toBe(nextToken)
    },
  )

  it.each([
    ["access token", (current: GitHubPair) => ({ ...current, token: "superseded-access-token" })],
    [
      "generation",
      (current: GitHubPair) => ({
        ...current,
        state: { ...current.state, generation: "superseded-generation" },
      }),
    ],
    [
      "rotation",
      (current: GitHubPair) => ({
        ...current,
        state: { ...current.state, rotation: current.state.rotation + 1 },
      }),
    ],
    [
      "attempt",
      (current: GitHubPair) => ({
        ...current,
        state: { ...current.state, attempt: "superseded-attempt" },
      }),
    ],
    [
      "refresh token",
      (current: GitHubPair) => ({
        ...current,
        state: { ...current.state, refreshToken: "superseded-refresh" },
      }),
    ],
    [
      "account",
      (current: GitHubPair) => ({
        ...current,
        state: { ...current.state, account: { id: 456, login: "other-account" } },
      }),
    ],
    [
      "scopes",
      (current: GitHubPair) => ({ ...current, state: { ...current.state, scopes: ["repo"] } }),
    ],
  ] as const)("compares the full old pair, including %s", (_name, mutate) => {
    save()
    const attempt = start()
    const before = persisted()
    const expected = mutate(attempt)
    expect(runtime.rotateGitHub(expected, nextToken, completed(attempt), "completed")).toBe(false)
    expect(runtime.rotateGitHub(expected, expected.token, failed(expected), "failed")).toBe(false)
    expect(persisted()).toEqual(before)
  })

  it.each(["reconnect", "disconnect", "manual"])(
    "cannot resurrect or invalidate credentials after %s",
    (operation) => {
      save()
      const attempt = start()
      if (operation === "reconnect")
        save(nextToken, credentials(nextToken, { generation: "replacement-generation" }))
      else if (operation === "disconnect") runtime.disconnectGitHub(store.snapshot().revision, "42")
      else manual(nextToken)
      const before = persisted()
      expect(runtime.rotateGitHub(attempt, nextToken, completed(attempt), "completed")).toBe(false)
      expect(runtime.rotateGitHub(attempt, attempt.token, failed(attempt), "failed")).toBe(false)
      expect(persisted()).toEqual(before)
    },
  )

  it("makes duplicate completion and stale failures no-ops", () => {
    save()
    const attempt = start()
    expect(runtime.rotateGitHub(attempt, nextToken, completed(attempt), "completed")).toBe(true)
    const before = persisted()
    expect(runtime.rotateGitHub(attempt, nextToken, completed(attempt), "completed")).toBe(false)
    expect(runtime.rotateGitHub(attempt, attempt.token, failed(attempt), "failed")).toBe(false)
    expect(persisted()).toEqual(before)
  })

  it.each([
    [
      "digest",
      (state: GitHubCredentials) => ({ ...state, accessDigest: githubAccessDigest("wrong") }),
    ],
    ["generation", (state: GitHubCredentials) => ({ ...state, generation: "other-generation" })],
    ["rotation", (state: GitHubCredentials) => ({ ...state, rotation: state.rotation + 1 })],
    ["Client ID", (state: GitHubCredentials) => ({ ...state, clientId: "other-client" })],
    [
      "account",
      (state: GitHubCredentials) => ({ ...state, account: { id: 456, login: "other-account" } }),
    ],
    [
      "uncleared attempt",
      (state: GitHubCredentials) => ({ ...state, attempt: "synthetic-attempt" }),
    ],
  ] as const)("rejects an invalid completion %s with full rollback", (_name, mutate) => {
    save()
    const attempt = start()
    const before = persisted()
    expect(() =>
      runtime.rotateGitHub(attempt, nextToken, mutate(completed(attempt)), "completed"),
    ).toThrow("Invalid runtime")
    expect(persisted()).toEqual(before)
  })

  it.each(["state", "audit"])("rolls back rotation if %s persistence fails", (target) => {
    save()
    const attempt = start()
    const before = persisted()
    store.db.exec(
      target === "state"
        ? `CREATE TRIGGER reject_rotation BEFORE INSERT ON runtime_config WHEN NEW.name='GITHUB_OAUTH_STATE' BEGIN SELECT RAISE(ABORT,'fixture'); END`
        : `CREATE TRIGGER reject_rotation BEFORE INSERT ON audit WHEN NEW.operation='github.refresh.completed' BEGIN SELECT RAISE(ABORT,'fixture'); END`,
    )
    expect(() => runtime.rotateGitHub(attempt, nextToken, completed(attempt), "completed")).toThrow(
      "fixture",
    )
    expect(persisted()).toEqual(before)
    restart()
    expect(pair().state.attempt).toBe(attempt.state.attempt)
    expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
  })

  it("persists unresolved attempts across restart and rejects a second start", () => {
    save()
    apply()
    const attempt = start()
    const before = persisted()
    restart()
    expect(persisted()).toEqual(before)
    expect(pair()).toEqual(attempt)
    expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
    expect(() =>
      runtime.rotateGitHub(
        attempt,
        attempt.token,
        { ...attempt.state, attempt: "retry-attempt" },
        "started",
      ),
    ).toThrow("Invalid runtime")
    expect(persisted()).toEqual(before)
    expect(runtime.rotateGitHub(attempt, attempt.token, failed(attempt), "failed")).toBe(true)
    expect(pair().state).toMatchObject({ reconnectRequired: true, rotation: 0 })
    expect(pair().state).not.toHaveProperty("attempt")
    expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
    restart()
    expect(pair().state.reconnectRequired).toBe(true)
    expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
  })

  it("can require reconnect for missing refresh credentials without an exchange attempt", () => {
    save(
      accessToken,
      credentials(accessToken, { refreshToken: undefined, expiresAt: Date.now() - 1 }),
    )
    apply()
    expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
    const current = pair()
    const before = store.snapshot()
    expect(runtime.rotateGitHub(current, current.token, failed(current), "failed")).toBe(true)
    expect(store.snapshot()).toEqual(before)
    expect(pair().state.reconnectRequired).toBe(true)
    expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
  })

  it("validates strictly bounded state without exposing invalid field values", () => {
    const state = credentials()
    expect(parseGitHubCredentials(state)).toEqual(state)
    for (const change of [
      { version: 2 },
      { generation: "" },
      { rotation: Number.MAX_SAFE_INTEGER + 1 },
      { expiresAt: -1 },
      { refreshExpiresAt: 0.5 },
      { account: { id: 0, login: "bad" } },
      { scopes: ["bad scope"] },
      { accessDigest: "not-a-digest" },
      { attempt: "" },
      { reconnectRequired: "true" },
      { unexpected: true },
    ])
      expect(parseGitHubCredentials({ ...state, ...change })).toBeUndefined()
  })
})
