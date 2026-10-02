# Sumire Login

A Pi package for UI-neutral OAuth login. Pi's `ModelRuntime.login` owns provider authentication, credential persistence, and token refresh. This package does not implement an agent loop or expose credentials to the UI host.

## Pi extension

Build and install from the repository root:

```bash
npm ci
npm run build --workspace @narumitw/sumire-login
pi install ./packages/login
```

Run `/provider-login` in Pi to sign in to OpenAI with ChatGPT. The command displays the browser URL and accepts the full callback URL through Pi's input dialog. It uses Pi's configured agent directory and refreshes the host registry after login. `/login` remains Pi's built-in command. Print/JSON sessions without UI cannot start this flow.

## SDK hosts

```typescript
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent"
import { createOAuthLogin } from "@narumitw/sumire-login"

const agentDir = "/path/to/private/agent-state"
const runtime = await ModelRuntime.create({ authPath: `${agentDir}/auth.json` })
const settings = SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false })
const login = createOAuthLogin(runtime, {
  getDeviceId: () => settings.getOrCreateDeviceId(),
})

await login.login({
  signal: abortController.signal,
  notify: showAuthEvent,
  prompt: requestUserInput,
})
```

The host supplies UI callbacks implementing Pi AI's `AuthInteraction`. Honor each prompt's `signal`, including dismissal when the browser callback wins. `login` resolves without credentials. It has a five-minute timeout by default (`timeoutMs`) and throws `OAuthLoginError` with `kind` equal to `failed`, `cancelled`, or `timeout`. Errors deliberately omit upstream messages and causes, which may contain authorization data. There are no automatic login retries. `providerId` defaults to `openai`.

Hosts must enforce authorization, serialize login attempts, keep authentication input out of model prompts and telemetry, and stop pending interactions on shutdown. Do not publish authentication URLs or inputs to a public content service. Storage must remain writable so Pi can rotate refresh tokens.

Sumire's Telegram adapter lives in `apps/bot/src/telegram/login.ts`. It exposes admin-only `/login` in private chats; the resulting account is shared by the whole bot. See `apps/bot/README.md` for deployment and privacy limits.
