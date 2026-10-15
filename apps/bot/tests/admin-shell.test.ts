import { expect, it } from "vitest"
import { adminShellEnvironment } from "../src/admin/shell.js"
import { codingTools } from "../src/agent/durable-tools.js"

it("does not inherit administrator or provider secrets into WebUI-managed shell tools", async () => {
  const environment = adminShellEnvironment({
    ...process.env,
    OPENAI_API_KEY: "provider-fixture",
    BOT_TOKEN: "bot-fixture",
    TELEGRAM_LOGIN_CLIENT_SECRET: "login-fixture",
    OTTER_TOKEN: "skill-fixture",
  })
  expect(environment).not.toHaveProperty("OPENAI_API_KEY")
  expect(environment).not.toHaveProperty("BOT_TOKEN")
  expect(environment).not.toHaveProperty("TELEGRAM_LOGIN_CLIENT_SECRET")
  const bash = codingTools(process.cwd(), environment).find((tool) => tool.name === "bash")
  const result = await bash?.execute(
    "fixture",
    {
      command:
        'printf "%s" "$OPENAI_API_KEY|$BOT_TOKEN|$TELEGRAM_LOGIN_CLIENT_SECRET|$OTTER_TOKEN"',
    },
    undefined,
    undefined,
    undefined as never,
  )
  expect(result?.content).toMatchObject([{ type: "text", text: "|||skill-fixture" }])
})
