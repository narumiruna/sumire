import type { AuthInteraction, LoginOptions } from "@earendil-works/pi-ai"
import type { ModelRuntime } from "@earendil-works/pi-coding-agent"

export interface OAuthLoginClient {
  login(interaction: AuthInteraction): Promise<void>
}

export class OAuthLoginError extends Error {
  constructor(readonly kind: "failed" | "cancelled" | "timeout") {
    super(`OAuth login ${kind}`)
    this.name = "OAuthLoginError"
  }
}

export function createOAuthLogin(
  runtime: Pick<ModelRuntime, "login">,
  options: LoginOptions & { providerId?: string; timeoutMs?: number } = {},
): OAuthLoginClient {
  return {
    async login(interaction) {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 300_000)
      const signal = interaction.signal ? AbortSignal.any([interaction.signal, timeout]) : timeout
      try {
        signal.throwIfAborted()
        // Pi owns token persistence and refresh. Never return credentials to the UI host.
        await runtime.login(
          options.providerId ?? "openai",
          "oauth",
          { ...interaction, signal },
          { getDeviceId: options.getDeviceId },
        )
      } catch {
        // Upstream errors can contain codes, tokens, or provider response bodies.
        throw new OAuthLoginError(
          interaction.signal?.aborted ? "cancelled" : timeout.aborted ? "timeout" : "failed",
        )
      }
    },
  }
}
