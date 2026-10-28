import fs, { readFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import path from "node:path"
import { expect, it, vi } from "vitest"
import { GitHubAuth } from "../src/admin/github-auth.js"
import { githubAccessDigest, githubStateName } from "../src/admin/github-state.js"
import { McpAdmin } from "../src/admin/mcp.js"
import type { GitHubTransport } from "../src/github-client.js"
import { callDurableTool } from "./helpers/durable-session.js"
import { createPiFixture } from "./helpers/pi-fixture.js"
import { createTestSessionFactory } from "./helpers/session-factory.js"

for (const tool of ["bash", "codemode"] as const) {
  it.each([
    ["public variable", "public-data", undefined],
    ["empty public variable", "", undefined],
    ["public variable with secret companion", "public-data", "secret"],
    ["public variable with public companion", "public-data", "variable"],
    ["orphaned secret companion", undefined, "secret"],
  ] as const)(
    `${tool} handles %s with production GitHub wiring`,
    async (_name, value, companion) => {
      const fixture = await createPiFixture()
      let github: GitHubAuth | undefined
      let session: Awaited<ReturnType<typeof fixture.createSession>> | undefined
      try {
        vi.stubEnv("GH_TOKEN", "ambient-github-secret")
        vi.stubEnv("GITHUB_TOKEN", "ambient-github-fallback")
        const { control: store, runtime } = fixture.factory
        if (!runtime) throw new Error("Missing runtime fixture")
        if (value !== undefined) {
          runtime.save(
            "GH_TOKEN",
            { revision: store.snapshot().revision, kind: "variable", value },
            "7",
          )
          store.applied(store.snapshot().revision, true)
        }
        if (companion) {
          const metadata = { revision: store.snapshot().revision, updatedAt: Date.now() }
          if (companion === "secret")
            runtime.values.setSecret(githubStateName, "invalid-companion-data", metadata)
          else runtime.values.setVariable(githubStateName, "invalid-companion-data", metadata)
        }
        const unexpected = async (): Promise<never> => {
          throw new Error("Unexpected GitHub request")
        }
        const client: GitHubTransport = {
          device: vi.fn(unexpected),
          exchange: vi.fn(unexpected),
          account: vi.fn(unexpected),
          refresh: vi.fn(unexpected),
        }
        github = new GitHubAuth(store, runtime, client)
        const mcp = new McpAdmin(store, fixture.settings.botWorkdir, runtime)
        const factory = await createTestSessionFactory(
          fixture.settings,
          fixture.logger,
          undefined,
          fixture.modelRuntime,
          { store, runtime, mcp, github },
        )
        session = await factory.create(123)
        const before = runtime.values.listMetadata()
        const audit = store.listAudit(0)
        const args = {
          command:
            // biome-ignore lint/suspicious/noTemplateCurlyInString: Bash expands these environment checks.
            'if [ "${GH_TOKEN+x}" = x ] || [ "${GITHUB_TOKEN+x}" = x ]; then printf unexpected-auth; exit 1; fi; printf ready; printf dispatched > public-gh-variable.txt',
          timeout: 5,
        }
        const result = await callDurableTool(
          session,
          tool,
          tool === "bash"
            ? args
            : { code: `text((await tools.bash(${JSON.stringify(args)})).output)` },
        )
        if (companion) {
          expect(result.isError).toBe(true)
          expect(JSON.stringify(result.content)).toContain("Reconnect GitHub")
          await expect(
            readFile(path.join(fixture.settings.botWorkdir, "public-gh-variable.txt")),
          ).rejects.toMatchObject({ code: "ENOENT" })
        } else {
          expect(result.isError).toBeFalsy()
          expect(result.content).toContainEqual({ type: "text", text: "ready" })
          expect(
            await readFile(
              path.join(fixture.settings.botWorkdir, "public-gh-variable.txt"),
              "utf8",
            ),
          ).toBe("dispatched")
        }
        expect(runtime.readVariable("GH_TOKEN")).toBe(value)
        expect(runtime.readSecret("GH_TOKEN")).toBeUndefined()
        expect(runtime.githubCredentials().kind).toBe("invalid")
        expect(runtime.values.listMetadata()).toEqual(before)
        expect(store.listAudit(0)).toEqual(audit)
        for (const method of Object.values(client)) expect(method).not.toHaveBeenCalled()
        const history = JSON.stringify(session.messages)
        for (const sentinel of [
          "public-data",
          "ambient-github-secret",
          "ambient-github-fallback",
          "invalid-companion-data",
        ])
          expect(history).not.toContain(sentinel)
      } finally {
        await session?.abort()
        await session?.dispose()
        await github?.close()
        await fixture.cleanup()
        vi.unstubAllEnvs()
      }
    },
  )

  it.each([
    "allowed",
    "revoked",
    "cancelled",
    "revoked-at-spawn",
    "cancelled-at-spawn",
    "replaced-at-spawn",
  ] as const)(
    `${tool} refreshes privately and checks %s dispatch after the wait`,
    async (outcome) => {
      const fixture = await createPiFixture()
      let github: GitHubAuth | undefined
      let session: Awaited<ReturnType<typeof fixture.createSession>> | undefined
      let release = () => {}
      let releaseAccess = () => {}
      let restoreAccess = () => {}
      try {
        const { control: store, runtime } = fixture.factory
        if (!runtime) throw new Error("Missing runtime fixture")
        const oldToken = "synthetic-access-before"
        runtime.saveGitHub(
          oldToken,
          {
            version: 1,
            generation: "shell-fixture",
            rotation: 0,
            clientId: "fixture",
            account: { id: 12, login: "fixture" },
            scopes: ["repo", "read:org"],
            accessDigest: githubAccessDigest(oldToken),
            expiresAt: Date.now() + 30_000,
            refreshToken: "synthetic-refresh-before",
            refreshExpiresAt: Date.now() + 1_000_000,
          },
          store.snapshot().revision,
          "7",
        )
        store.applied(store.snapshot().revision, true)
        let entered = () => {}
        const started = new Promise<void>((resolve) => {
          entered = resolve
        })
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        const unexpected = async (): Promise<never> => {
          throw new Error("Unexpected protocol request")
        }
        const client: GitHubTransport = {
          device: unexpected,
          exchange: unexpected,
          account: unexpected,
          refresh: vi.fn(async () => {
            entered()
            await gate
            return {
              accessToken: "synthetic-access-after",
              scopes: ["repo", "read:org"],
              expiresIn: 28_800,
              refreshToken: "synthetic-refresh-after",
              refreshExpiresIn: 1_000_000,
            }
          }),
        }
        github = new GitHubAuth(store, runtime, client)
        const mcp = new McpAdmin(store, fixture.settings.botWorkdir, runtime)
        const factory = await createTestSessionFactory(
          fixture.settings,
          fixture.logger,
          undefined,
          fixture.modelRuntime,
          { store, runtime, mcp, github },
        )
        session = await factory.create(123)
        const late = outcome.endsWith("-at-spawn")
        let enteredAccess = () => {}
        const accessStarted = new Promise<void>((resolve) => {
          enteredAccess = resolve
        })
        if (late) {
          const original = fs.access
          const accessGate = new Promise<void>((resolve) => {
            releaseAccess = resolve
          })
          fs.access = async (...args) => {
            if (String(args[0]) === fixture.settings.botWorkdir) {
              enteredAccess()
              await accessGate
            }
            return original(...args)
          }
          syncBuiltinESMExports()
          restoreAccess = () => {
            fs.access = original
            syncBuiltinESMExports()
          }
        }
        const args = {
          command:
            'printf dispatched > github-shell.txt; if [ -n "$GH_TOKEN" ]; then printf authenticated; else printf missing; fi',
          timeout: 5,
        }
        const pending = callDurableTool(
          session,
          tool,
          tool === "bash"
            ? args
            : { code: `text((await tools.bash(${JSON.stringify(args)})).output)` },
        )
        // Attach rejection handling before cancellation can settle a durable task.
        const settled = pending.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
        await started
        if (late) {
          release()
          await accessStarted
        }
        if (outcome.startsWith("revoked")) {
          const state = store.snapshot()
          state.policy.defaults.tools = (state.policy.defaults.tools ?? []).filter(
            (name) => name !== "bash",
          )
          store.save(state.policy, state.revision, "7")
          store.applied(store.snapshot().revision, true)
        }
        if (outcome === "replaced-at-spawn") {
          runtime.save(
            "GH_TOKEN",
            { revision: store.snapshot().revision, kind: "secret", value: "replacement-pat" },
            "7",
          )
          store.applied(store.snapshot().revision, true)
        }
        const abort = outcome.startsWith("cancelled") ? session.abort() : undefined
        release()
        releaseAccess()
        const result = await settled
        await abort
        if (outcome === "allowed") {
          expect("value" in result && result.value.isError).toBeFalsy()
          expect("value" in result && result.value.content).toContainEqual({
            type: "text",
            text: "authenticated",
          })
          expect(
            await readFile(path.join(fixture.settings.botWorkdir, "github-shell.txt"), "utf8"),
          ).toBe("dispatched")
        } else {
          expect("error" in result || result.value.isError).toBe(true)
          await expect(
            readFile(path.join(fixture.settings.botWorkdir, "github-shell.txt")),
          ).rejects.toMatchObject({ code: "ENOENT" })
        }
        expect(client.refresh).toHaveBeenCalledOnce()
        const history = JSON.stringify(session.messages)
        for (const sentinel of [
          oldToken,
          "synthetic-access-after",
          "synthetic-refresh-before",
          "synthetic-refresh-after",
        ])
          expect(history).not.toContain(sentinel)
      } finally {
        release()
        releaseAccess()
        restoreAccess()
        await session?.abort()
        await session?.dispose()
        await github?.close()
        await fixture.cleanup()
      }
    },
  )
}
