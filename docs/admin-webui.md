# Administration WebUI

The WebUI manages chat access, tools, MCP servers, models, thinking levels, and model providers. It uses React, Radix Themes, Radix Primitives, Radix Colors, and Radix Icons. The bot serves the frontend and API from one origin.

## Enable Telegram login

1. Select the bot in BotFather. Open **Bot Settings > Web Login**.
2. Register the public HTTPS origin and its exact callback URL, for example `https://sumire.example.com` and `https://sumire.example.com/auth/callback`.
3. Set these bootstrap values in the root `.env`:

   ```dotenv
   BOT_ADMIN_ID=123456789
   ADMIN_ORIGIN=https://sumire.example.com
   TELEGRAM_LOGIN_CLIENT_ID=your-client-id
   TELEGRAM_LOGIN_CLIENT_SECRET=your-client-secret
   ADMIN_HOST=127.0.0.1
   ADMIN_PORT=17465
   ```

   - Use the real administrator's numeric Bot API user ID, not a username or an OIDC subject.
   - The login client credentials come from BotFather. They are not the bot token.
   - `ADMIN_ORIGIN` must have no trailing slash, path, query, or fragment.
   - Keep `BOT_TOKEN` and other required bot credentials configured as before.
   - Leaving `ADMIN_ORIGIN` unset preserves the deployment without the WebUI.
4. Route the public HTTPS origin to the private backend. Retain the original Host header. Do not publish the application port on a public interface.
5. Sign in with Telegram. Other Telegram users cannot obtain an administrator session. Bot access does not grant administrator access.

Sumire uses Telegram's current official Authorization Code flow with PKCE, a browser-bound one-use transaction, and a nonce. It verifies RS256 ID tokens against Telegram's JWKS, issuer, audience, issue time, expiration, and nonce. Authorization uses the signed `profile.id` claim. The OIDC `sub` is a different identifier. Sumire requests `openid profile`, not a phone number or bot messaging permission.

Reference: <https://core.telegram.org/bots/telegram-login>.

## HTTPS deployment

Check ports before starting services:

```sh
listenr
```

The default backend port is **17465**. It was available when selected. The development frontend uses **17466** with strict port checking. Recheck both on the deployment host. Do not stop another service to free a port.

Use the root Compose files:

```sh
docker compose -f compose.yaml -f compose.admin.yaml up -d --build
```

The administration override binds `127.0.0.1:17465` on the host and listens on all container interfaces. It does not claim host port 443. Attach the host's existing HTTPS ingress. For example, an existing Caddy installation can use:

```caddyfile
sumire.example.com {
    reverse_proxy 127.0.0.1:17465 {
        header_up Host {http.request.host}
    }
}
```

For a reverse proxy in another container, use a private Docker network and the `sumire:17465` service address instead of host loopback. Do not publish the backend on `0.0.0.0` on the host. Configure TLS, ingress access logs, and the public domain outside Sumire. Ingress logs must omit callback query strings: they contain short-lived authorization codes.

The backend does not trust `Forwarded` or `X-Forwarded-*` headers. It uses the configured HTTPS origin and checks the Host header. Rate limits use the socket peer, so a proxy shares the login budget across users. This is suitable for the single-administrator service. Configure matching body and request limits at the ingress. `/healthz` is a liveness check, not proof of valid providers or applied settings.

Cookies are host-only, Secure, HttpOnly, and SameSite=Lax. Administrator sessions expire after 30 idle minutes or eight hours total. Mutations require the session's CSRF token and the exact Origin. Logout revokes the server-side session and cancels provider login interactions owned by it.

## First-start import

The database is `.telegramagent/admin.sqlite`, separate from Pi's session databases.

- Positive `BOT_WHITELIST` IDs become private-message users. Negative IDs become group or channel IDs.
- This narrows old sender-based group authorization: an approved private user no longer authorizes an otherwise unapproved group.
- Existing `mcp.json` entries are copied once into protected administration state. The source remains unchanged. The read-only Docker mount remains an import source, not the active editable configuration after import.
- Provider credentials remain in Pi's existing credential store. Provider metadata references and existing per-chat model selections are imported without copying credentials into settings.
- Session model import reads a consistent temporary SQLite backup through Pi's storage API. It does not run a conversation, change the source database, or delete transcripts.
- New capabilities are not automatically approved. Shell and file tools start unavailable in the new global policy, including for imported chats.
- Import reports appear on the Audit page and at the authenticated `/api/imports` endpoint. Partial model imports list chat IDs and unscanned directory entries that need review. The importer scans at most 1,000 entries, stops starting new copies after 60 seconds, and limits each session copy to 1 GB and 30 seconds. Imports do not overwrite later WebUI edits on restart.

Review imported access, model selections, and MCP entries before enabling capabilities. Select global model availability, defaults, and per-chat settings. A new chat is denied until its ID is approved. Knowing an ID is not authorization to approve it.

## Policy behavior

Global lists are availability ceilings. Global defaults select from those lists. Chat overrides can narrow or select within the ceiling, not exceed it. `Inherit default` and an explicit empty list have different meanings. An empty list allows nothing. The Chats page displays effective saved values and their sources.

MCP server permission and individual tool permission are both required. `direct`, `codemode`, and `hidden` control exposure, not authorization. Discover a server's tools before approving their exact names. New server tools remain denied until approved.

Saving settings writes a revision and an audit record together. Runtime application cancels affected admitted work and closes cached sessions without deleting history. Current implementation rebuilds all cached chats for an administration change, not only the changed chat. An authorization epoch also cancels pre-change persisted work after restart, including MCP-only edits. New calls are denied while a revision is pending or failed. Completed external side effects cannot be reversed. A failed application remains visible and can be retried.

| State | Enforcement |
| --- | --- |
| Unknown or denied chat | Reject before commands, attachments, callbacks, or passive context. |
| Pending or failed revision | Deny new model and tool calls; keep administrator repair endpoints available. |
| Previously discovered tool | Recheck current authorization at execution, including calls through codemode. |
| Active work during application | Cancel queued and active work, close cached sessions, and retain transcript files. |
| Restart or branch restoration | Restore current model settings and enforce current permissions; do not replay withdrawn unsafe work. |
| External action already started | Cancellation cannot reverse an external effect. |

Telegram `/model` and `/thinking` use the same persisted chat selection as the WebUI. They cannot select models outside the effective allowlist. `/reset` removes conversation state but not administrator-owned chat settings. Model requests, compaction, native tools, codemode's native tool calls, and MCP calls check current authorization.

## Model providers

Use **Model Providers** to select built-in providers or configure a public compatible endpoint. Custom endpoints require an API type and explicit chat model metadata. Supported custom API types are OpenAI Completions, OpenAI Responses, Anthropic Messages, and Google Generative AI. Administration policies select physical chat models, not virtual routers, classifiers, or image-generation models. Model IDs may contain slashes; provider IDs cannot.

- Save provider configuration before authenticating it.
- API keys are literal secrets, not Pi command or environment expressions. Existing keys are never returned to the frontend.
- Provider OAuth is available only when Pi reports that provider's support. Complete its device or manual-code interaction in the UI. The interaction expires after five minutes and is cancelled on logout or shutdown. Restart does not resume pending OAuth.
- Pi owns credential persistence and token refresh. The WebUI does not receive access or refresh tokens.
- Some providers require ambient cloud credentials or provider-specific environment values. Configure those on the trusted host; the API-key replacement form does not implement every provider-specific setup prompt.
- Authentication checks report configured availability. They do not generate tokens or prove that a remote service accepts a credential. Custom OpenAI-compatible `/models` discovery is a bounded connection check; discovered IDs need model metadata before use.
- Custom provider requests use DNS-validated public HTTP(S) transport, reject URL credentials and redirects, and enforce time and streamed response byte limits. Private, local, metadata, link-local, and non-routable endpoints are rejected. Custom transport uses SSE, not WebSocket.
- Custom model cost metadata is unknown. Pi requires numeric costs, so configured custom entries use zero placeholders; do not treat reported costs as verified free usage.
- Replace every global and chat reference before disabling a provider or removing credentials. No silent fallback selects another provider.
- Clear model references before removing a custom endpoint override. Save that change before approving models from the restored built-in catalog. Removing an administrator configuration restores built-in provider behavior where applicable. Removing a saved credential does not remove ambient environment credentials or revoke a token at the upstream provider.

## MCP configuration and secrets

Only the administrator can change MCP commands, endpoints, environment fields, headers, timeouts, and exposure rules. Starting a configured stdio server executes administrator-supplied code. Connection tests can therefore have startup effects even though they do not invoke tools.

MCP configuration supports the existing transport fields. An update preserves omitted fields. For `env` and `headers`, null preserves a named value, a literal replaces it, and an empty object clears the map. Use these maps for secrets; do not put secrets in commands, arguments, descriptions, names, or URLs. Ordinary inventory responses show configured markers and field names, not existing secret values.

MCP may depend on private Docker endpoints. Existing MCP HTTP protections remain separate from the public-only custom model provider policy; do not assume MCP endpoints are public-only. Redirects never forward administrator credentials.

## Trust boundary

Tools are capabilities, not an OS sandbox. Pi, shell tools, and stdio MCP processes run with the container user's permissions. A working directory does not confine file access. A shell or file tool can read process-readable state, modify policy or credential files, and reach the network without using another named tool. Administrator-supplied MCP code has the same trust requirement.

For WebUI-managed chats, shell tools receive a restricted environment: system and runtime paths, locale fields, and the existing Otter and Firecrawl skill credentials. They do not directly inherit bot tokens, Telegram login secrets, or ambient model provider keys. Deployments without the WebUI retain the existing shell environment behavior. MCP retains its existing explicit environment policy.

Sumire does not inject stored model provider credentials into tool or MCP environments, but same-user file access is not isolated. Do not enable shell or unrestricted file tools for untrusted chats. Do not claim credential isolation when these capabilities are enabled. Use a separate tested OS or VM boundary if that isolation is required. This release does not add such a boundary.

## Backup and recovery

Before enabling the WebUI or changing versions:

1. Stop ingress traffic and stop the bot from the repository root.
2. Back up the state volume, source MCP configuration, and bootstrap secrets with restricted access. Include Pi's `auth.json`, model store, and all session SQLite files and their SQLite sidecar files. Never commit this backup.
3. Start the selected application version, inspect the import report and effective policies, then reopen ingress.

Use a consistent SQLite backup or a stopped-service volume snapshot, not an unsynchronized copy of a running database. To recover from lockout, use trusted host access to correct `BOT_ADMIN_ID` or login client settings. To revoke all administrator sessions while stopped, delete rows from the administration database's `sessions` table using a trusted SQLite tool. Do not delete the database to log out: that would discard policies and trigger import again.

For rollback, restore the compatible image and matching state backup together while the bot and ingress are stopped. Review access before restart: old whitelist behavior can broaden group access. Revoke administrator sessions before reopening HTTPS. Failed settings application does not restore revoked permissions automatically.

## Development and verification

Use Node.js 22.19 or newer from the repository root:

```sh
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:browser --workspace @narumitw/sumire-admin
```

After building, `node apps/bot/scripts/check-admin.mjs` runs an offline HTTPS smoke test with temporary certificates and state. It checks production assets, session and CSRF enforcement, logout cookies, restart persistence, and the absence of same-user file isolation. It does not use real bot credentials or contact Telegram or providers. In Compose, use an isolated test override with no environment file, persistent volumes, published ports, or external network.

The browser suite uses API fixtures and a strict-port development server. It does not prove live Telegram login, real provider OAuth, or public TLS. For an authenticated local browser session, serve the production build behind the configured HTTPS origin. Do not disable Secure cookies or add an authentication bypass for development.

Before production acceptance, verify real Telegram login and unauthorized-user rejection on the registered domain, provider authentication with the selected providers, revocation during active work, restart persistence, backup restoration, and HTTPS ingress behavior. Live identity and provider tests require the administrator and deployment credentials; do not substitute unit fixtures for this evidence.
