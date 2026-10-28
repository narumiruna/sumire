import { expect, it, vi } from "vitest"
import { RuntimeConfigAdmin } from "../src/admin/runtime-config.js"
import { adminShellEnvironment } from "../src/admin/shell.js"
import { callDurableTool } from "./helpers/durable-session.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

it.each(["bash", "codemode"] as const)(
  "%s uses the current applied GitHub token without rebuilding the factory",
  async (tool) => {
    const fixture = await createPiFixture()
    try {
      vi.stubEnv("GH_TOKEN", "host-github-token")
      vi.stubEnv("GITHUB_TOKEN", "host-github-fallback")
      const { runtime, control } = fixture.factory
      if (!runtime) throw new Error("Missing runtime fixture")
      const session = await fixture.createSession()
      const args = { command: 'printf "%s|%s" "$GH_TOKEN" "$GH_PROMPT_DISABLED"', timeout: 5 }
      const call = () =>
        callDurableTool(
          session,
          tool,
          tool === "bash"
            ? args
            : { code: `text((await tools.bash(${JSON.stringify(args)})).output)` },
        )
      const expectToken = async (token: string) => {
        const result = await call()
        expect(result.isError).toBeFalsy()
        expect(result.content).toContainEqual({ type: "text", text: `${token}|1` })
      }
      const save = (value: string, kind: "secret" | "variable" = "secret") =>
        runtime.save("GH_TOKEN", { revision: control.snapshot().revision, kind, value }, "7")
      const apply = (success = true) => control.applied(control.snapshot().revision, success)
      const expectWithheld = async () => {
        expect(adminShellEnvironment(process.env, runtime)).not.toHaveProperty("GH_TOKEN")
        expect((await call()).isError).toBe(true)
      }
      const originalPolicy = control.snapshot().policy

      await expectToken("")
      save("managed-github-first")
      await expectWithheld()
      apply(false)
      await expectWithheld()
      apply()
      await expectToken("managed-github-first")

      save("managed-github-replacement")
      await expectWithheld()
      apply(false)
      await expectWithheld()
      apply()
      await expectToken("managed-github-replacement")

      save("github-invalid-sentinel\0private")
      apply()
      const invalidMessage = "Stored GH_TOKEN is invalid; replace it in Secrets & variables."
      expect(() => adminShellEnvironment(process.env, runtime)).toThrow(invalidMessage)
      const invalid = await call()
      expect(invalid.isError).toBe(true)
      expect(JSON.stringify(invalid.content)).toContain(invalidMessage)
      expect(JSON.stringify(invalid)).not.toContain("github-invalid-sentinel")
      save("managed-github-repaired")
      apply()
      await expectToken("managed-github-repaired")

      const locked = new RuntimeConfigAdmin(control, Buffer.alloc(32, 9).toString("base64"))
      expect(locked.snapshot().secretStatus).toBe("locked")
      expect(adminShellEnvironment(process.env, locked)).not.toHaveProperty("GH_TOKEN")
      expect(
        adminShellEnvironment(process.env, new RuntimeConfigAdmin(control)),
      ).not.toHaveProperty("GH_TOKEN")

      runtime.remove("GH_TOKEN", control.snapshot().revision, "7")
      await expectWithheld()
      apply(false)
      await expectWithheld()
      apply()
      await expectToken("")
      save("public-variable-is-not-a-credential", "variable")
      apply()
      await expectToken("")
      expect(control.snapshot().policy).toEqual(originalPolicy)
      expect(JSON.stringify(runtime.snapshot())).not.toContain("managed-github")
      expect(JSON.stringify(control.listAudit(0))).not.toContain("managed-github")
    } finally {
      vi.unstubAllEnvs()
      await fixture.cleanup()
    }
  },
)

it("does not inherit administrator or provider secrets into native shell tools", async () => {
  vi.stubEnv("OPENAI_API_KEY", "provider-fixture")
  vi.stubEnv("BOT_TOKEN", "bot-fixture")
  vi.stubEnv("TELEGRAM_LOGIN_CLIENT_SECRET", "login-fixture")
  vi.stubEnv("OTTER_TOKEN", "skill-fixture")
  vi.stubEnv("FIRECRAWL_API_KEY", "managed-fixture")
  vi.stubEnv("MORSEL_API_KEY", "morsel-fixture")
  vi.stubEnv("ENCRYPTION_KEY", "master-fixture")
  vi.stubEnv("GH_TOKEN", "host-github-fixture")
  vi.stubEnv("GITHUB_TOKEN", "host-github-fallback-fixture")
  vi.stubEnv("GH_ENTERPRISE_TOKEN", "host-enterprise-fixture")
  try {
    const environment = adminShellEnvironment(process.env)
    for (const name of [
      "OPENAI_API_KEY",
      "BOT_TOKEN",
      "TELEGRAM_LOGIN_CLIENT_SECRET",
      "FIRECRAWL_API_KEY",
      "MORSEL_API_KEY",
      "ENCRYPTION_KEY",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
    ])
      expect(environment).not.toHaveProperty(name)
    const fixture = await createPiFixture()
    try {
      const session = await fixture.createSession()
      const result = await callDurableTool(session, "bash", {
        command:
          'printf "%s" "$OPENAI_API_KEY|$BOT_TOKEN|$TELEGRAM_LOGIN_CLIENT_SECRET|$OTTER_TOKEN|$GH_TOKEN|$GITHUB_TOKEN|$GH_ENTERPRISE_TOKEN"',
      })
      expect(result.content).toMatchObject([{ type: "text", text: "|||skill-fixture|||" }])
    } finally {
      await fixture.cleanup()
    }
  } finally {
    vi.unstubAllEnvs()
  }
})
