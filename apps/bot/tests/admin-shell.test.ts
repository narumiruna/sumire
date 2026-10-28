import { expect, it, vi } from "vitest"
import { adminShellEnvironment } from "../src/admin/shell.js"
import { callDurableTool } from "./helpers/durable-session.js"
import { createPiFixture } from "./helpers/pi-fixture.js"

it("does not inherit administrator or provider secrets into native shell tools", async () => {
  vi.stubEnv("OPENAI_API_KEY", "provider-fixture")
  vi.stubEnv("BOT_TOKEN", "bot-fixture")
  vi.stubEnv("TELEGRAM_LOGIN_CLIENT_SECRET", "login-fixture")
  vi.stubEnv("OTTER_TOKEN", "skill-fixture")
  vi.stubEnv("FIRECRAWL_API_KEY", "managed-fixture")
  vi.stubEnv("MORSEL_API_KEY", "morsel-fixture")
  vi.stubEnv("ENCRYPTION_KEY", "master-fixture")
  try {
    const environment = adminShellEnvironment(process.env)
    for (const name of [
      "OPENAI_API_KEY",
      "BOT_TOKEN",
      "TELEGRAM_LOGIN_CLIENT_SECRET",
      "FIRECRAWL_API_KEY",
      "MORSEL_API_KEY",
      "ENCRYPTION_KEY",
    ])
      expect(environment).not.toHaveProperty(name)
    const fixture = await createPiFixture()
    try {
      const session = await fixture.createSession()
      const result = await callDurableTool(session, "bash", {
        command:
          'printf "%s" "$OPENAI_API_KEY|$BOT_TOKEN|$TELEGRAM_LOGIN_CLIENT_SECRET|$OTTER_TOKEN"',
      })
      expect(result.content).toMatchObject([{ type: "text", text: "|||skill-fixture" }])
    } finally {
      await fixture.cleanup()
    }
  } finally {
    vi.unstubAllEnvs()
  }
})
