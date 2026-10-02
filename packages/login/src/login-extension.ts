import type { AuthEvent } from "@earendil-works/pi-ai"
import { type ExtensionAPI, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent"

import { createOAuthLogin, OAuthLoginError } from "./oauth-login.js"

export default function loginExtension(pi: ExtensionAPI): void {
  let active: AbortController | undefined
  pi.on("session_shutdown", () => active?.abort())
  // /login belongs to Pi's built-in UI. Use a distinct extension command.
  pi.registerCommand("provider-login", {
    description: "Sign in to OpenAI with ChatGPT using Pi OAuth",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("OAuth login requires an interactive UI host.", "warning")
        return
      }
      if (active) {
        ctx.ui.notify("An OAuth login is already running.", "warning")
        return
      }
      const controller = new AbortController()
      active = controller
      try {
        const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: false })
        // Extensions receive a read/stream registry facade, not ModelRuntime.login.
        // Use Pi's agent-directory storage, then refresh the session's facade.
        const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false })
        const login = createOAuthLogin(runtime, {
          getDeviceId: () => settings.getOrCreateDeviceId(),
        })
        await login.login({
          signal: controller.signal,
          notify: (event) => ctx.ui.notify(notification(event), "info"),
          prompt: async (prompt) => {
            if (prompt.type === "secret") throw new OAuthLoginError("failed")
            const value =
              prompt.type === "select"
                ? await ctx.ui.select(
                    prompt.message,
                    prompt.options.map((option) => option.id),
                    { signal: prompt.signal },
                  )
                : await ctx.ui.input(prompt.message, prompt.placeholder, { signal: prompt.signal })
            if (value === undefined) {
              controller.abort()
              throw new OAuthLoginError("cancelled")
            }
            return value
          },
        })
        await ctx.modelRegistry.refresh({ allowNetwork: false })
        ctx.ui.notify("OpenAI login completed.", "info")
      } catch (error) {
        ctx.ui.notify(
          error instanceof OAuthLoginError ? error.message : "OAuth login failed",
          "warning",
        )
      } finally {
        if (active === controller) active = undefined
      }
    },
  })
}

function notification(event: AuthEvent): string {
  switch (event.type) {
    case "auth_url":
      return `${event.url}\n${event.instructions ?? "Complete sign-in in your browser."}`
    case "device_code":
      return `${event.verificationUri}\nCode: ${event.userCode}`
    case "info":
    case "progress":
      return event.message
  }
}
