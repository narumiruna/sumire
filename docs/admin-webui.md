# Administration WebUI

The WebUI manages chat access, tools, MCP servers, models, thinking levels, and model providers. It uses React, Radix Themes, Radix Primitives, Radix Colors, and Radix Icons. The bot serves the frontend and API from one origin.

## Enable passkey login

1. Set the bootstrap values in the root `.env`:

   ```dotenv
   BOT_ADMIN_ID=123456789
   ADMIN_HOST=127.0.0.1
   ADMIN_PORT=17465
   ```

   - Use the real administrator's numeric Bot API user ID.
   - Keep `BOT_TOKEN` and other required bot credentials configured as before.
   - `BOT_ADMIN_ID` is required. It configures the always-on WebUI but does not grant bot chat access. Without `ADMIN_ORIGIN`, the browser URL is `http://localhost:17465`. Outside the supplied Compose configuration, a custom `ADMIN_PORT` changes this URL too. The supplied `compose.yaml` fixes the backend and published port at `17465`; an `ADMIN_PORT` value in `.env` does not override it.
   - Local passkeys require a browser that supports WebAuthn and Secure cookies on `localhost`. Open the URL on the computer that runs Sumire. Do not replace `localhost` with a LAN address or open it inside Telegram.
   - For remote access, set `ADMIN_ORIGIN=https://sumire.example.com`. An explicit origin must use HTTPS with no trailing slash, path, query, or fragment.
   - Missing or blank `BOT_ADMIN_ID` stops startup, even when model credentials already exist. `ADMIN_PORT` must be an integer from 1 to 65535.
   - An unset, empty, or whitespace-only `ADMIN_HOST` uses `127.0.0.1`. Set `0.0.0.0` only inside a private container network. Keep the published host port private.
   - Telegram Web Login, BotFather domain registration, and `TELEGRAM_LOGIN_CLIENT_ID` / `TELEGRAM_LOGIN_CLIENT_SECRET` are not required. Remove unused login credentials from the deployment.
2. For remote HTTPS access only, route the configured origin to the private backend. Retain the original Host header. Do not publish the application port on a public interface. Local access needs no reverse proxy.
3. Rebuild and restart with `docker compose up -d --build sumire`.
4. Send `/admin` in a private chat with Sumire. Only `BOT_ADMIN_ID` receives the setup link. This command works before chat approval and while policies are pending or failed. It does not start a model turn or grant bot access.
5. For local access, copy the private setup URL into a browser on the computer that runs Sumire. For HTTPS access, open **Register passkey** in your system browser. Complete the device fingerprint, face, or PIN check.
   - The setup link expires after five minutes. Only the newest link works. Do not forward it or share it. Telegram bot chats are not end-to-end encrypted.
   - The token is in the URL fragment, not an HTTP query. The page removes the fragment before registration requests. The server stores only its hash.
   - Registration requires the private setup token and a one-use browser-bound challenge. Public visitors cannot claim an unconfigured account.
6. Later visits use **Sign in with passkey**. Open `http://localhost:17465`, the configured `ADMIN_ORIGIN`, or use `/admin` again. Once a passkey exists, `/admin` sends only the ordinary WebUI link. It cannot add or replace a credential.

The server uses SimpleWebAuthn to check the challenge, exact origin, RP ID, user verification, signature, credential owner, and authenticator counter. Synced passkeys with zero counters are supported. Session cookies remain Secure and HttpOnly. Mutation requests require Origin and CSRF checks.

The initial credential can be synced through your device's passkey provider. Another device can also use the browser's supported cross-device passkey flow. The passkey belongs to the configured domain. A domain change can require recovery and new enrollment. This includes a move from `localhost` to a public domain. Local setup does not add a password fallback or let public visitors create an account.

Reference: <https://simplewebauthn.dev/docs/packages/server>.

## HTTPS deployment

Check ports before starting services:

```sh
listenr
```

The default backend port is **17465**. It was available when selected. The development frontend uses **17466** with strict port checking. Recheck both on the deployment host. Do not stop another service to free a port.

Use the root `compose.yaml`:

```sh
docker compose up -d --build
```

Compose binds `127.0.0.1:17465` on the host and listens on all container interfaces when the WebUI is enabled. To change that port in Compose, update its `environment`, `ports`, and healthcheck together; changing `.env` alone has no effect. The healthcheck fails when the required administrator ID is missing; otherwise it checks the WebUI with the configured Host header. It does not claim host port 443. Attach the host's existing HTTPS ingress. For example, an existing Caddy installation can use:

```caddyfile
sumire.example.com {
    reverse_proxy 127.0.0.1:17465 {
        header_up Host {http.request.host}
    }
}
```

For a reverse proxy in another container, use a private Docker network and the `sumire:17465` service address instead of host loopback. Do not publish the backend on `0.0.0.0` on the host. Configure TLS, ingress access logs, and the public domain outside Sumire. Ingress logs must not record request bodies. Passkey setup tokens are sent only in same-origin JSON bodies, not URL queries.

The backend does not trust `Forwarded` or `X-Forwarded-*` headers. It uses the exact configured origin, or the default localhost origin, and checks the Host header. It sends HSTS only for an HTTPS origin. Rate limits use the socket peer, so a proxy shares the login budget across users. This is suitable for the single-administrator service. Configure matching body and request limits at the ingress. `/healthz` is a liveness check, not proof of valid providers or applied settings.

Cookies are host-only, Secure, HttpOnly, and SameSite=Strict. Administrator sessions expire after seven idle days or 30 days total. Authenticated API requests reset the idle timeout but do not extend the total lifetime. Mutations require the session's CSRF token and the exact Origin. Logout revokes the server-side session and cancels provider login interactions owned by it.

## First-start import

The database is `.telegramagent/admin.sqlite`, separate from Pi's session databases.

- New databases start with empty private-user and group/channel access lists. Neither the administrator ID nor obsolete environment access values seed chat grants.
- Existing database grants and disabled chat overrides remain unchanged. An approved private user never authorizes an otherwise unapproved group.
- Valid `mcp.json` entries are copied once into protected administration state. Invalid entries are skipped. The import report records accepted and skipped counts without rejected names or values. The source remains unchanged. After import, restart does not read the source again. The read-only Docker mount remains an import source, not the active editable configuration after import.
- Provider credentials remain in Pi's existing credential store. Provider metadata references and existing per-chat model selections are imported without copying credentials into settings.
- Model selections with missing models or unsupported thinking levels are skipped and listed as failed chat IDs. Valid selections still import. No fallback changes a saved selection.
- Session model import reads a consistent temporary SQLite backup through Pi's storage API. It does not run a conversation, change the source database, or delete transcripts.
- New capabilities are not automatically approved. Shell and file tools start unavailable in the new global policy, including for imported chats.
- Import reports appear on the Audit page and at the authenticated `/api/imports` endpoint. Partial model imports list chat IDs and unscanned directory entries that need review. The importer scans at most 1,000 entries, stops starting new copies after 60 seconds, and limits each session copy to 1 GB and 30 seconds. Imports do not overwrite later WebUI edits on restart.

Review imported access, model selections, and MCP entries before enabling capabilities. Select global model availability, defaults, and per-chat settings. A new chat is denied until its ID is approved. Knowing an ID is not authorization to approve it.

## Request chat access with /allow

1. Send `/allow` without arguments in the private chat, group, or supergroup to approve. `/allow@your_bot` also works. Ordinary denied messages remain silent. Channel posts do not support this command; manage channel IDs in the WebUI.
2. Give the returned link to the administrator. With HTTPS, use **Review chat access**. With the default localhost origin, copy the URL into a browser on the computer that runs Sumire, not Telegram's embedded browser. A phone's `localhost` is not the Sumire host. Remote access requires an HTTPS `ADMIN_ORIGIN` and a Passkey registered for that domain.
3. Sign in with the existing administrator Passkey. The page removes the token fragment before network requests and retains the pending request in browser-tab session storage through sign-in and reload. Storage-disabled browsers cannot retain it through reload. Success, invalidation, expiry, dismissal, or sign-out clears the intent.
4. Check the displayed chat name, type, and numeric ID, then select **Approve chat**. Opening the URL and signing in do not grant access. Chat names are untrusted labels; verify the ID before approval. A link cannot enroll a Passkey or authorize a non-administrator.
5. Check the application status and expandable revision details. Approval cancels active work through the normal policy application worker. Pending or failed application denies new work; use **Retry application** after correcting any configuration failure. Approval does not enable additional tools, MCP servers, or models.

The server generates a 32-byte random hex token and stores only its SHA-256 hash with the Telegram-supplied chat metadata and configured origin. Links expire after 15 minutes. A new request replaces the previous link for that chat after a one-minute cooldown. At most 1,000 unexpired requests exist. Restart retains pending requests until expiry. Changing origin invalidates them. The URL does not accept a caller-supplied target chat ID.

Resolution and approval require an administrator session, exact Origin, CSRF token, and same-origin JSON POST. Approval atomically consumes the request, changes only that chat's access, and records an audit event and policy revision. A disabled override is enabled without changing its other selections. Revision conflicts leave the request usable; reload and review before confirming again. A consumed link cannot restore later-revoked access. Do not log HTTP request bodies at ingress: resolution and approval bodies contain request tokens.

## Upgrade to database-only access

This is a breaking bootstrap change: `BOT_ADMIN_ID` is now required, and the WebUI and SQLite administration policy are always used. `BOT_WHITELIST` has been removed; old values are ignored, including malformed values. There is no environment-based fallback for unavailable storage, denied chats, or pending/failed policy.

1. Before upgrading, run Stage 1 and review every configured environment ID on its **Access → Review environment access** page. Confirm intended grants and retained denials. Verify real Passkey sign-in, private/group `/allow`, and restart persistence.
2. Stop the bot and back up the state, runtime bootstrap configuration, and matching Stage 1 image reference under private access controls. Never commit credentials or backup contents.
3. Keep the same SQLite state volume and `BOT_ADMIN_ID`. Remove the obsolete environment variable from deployment settings, then rebuild and restart through the root Compose workflow.
4. Verify the saved/applied revision, existing allowed and denied chats, `/admin`, and `/allow` after restart. A new installation has no grants; use the administrator's private `/admin` setup path and then `/allow` for the chat to approve.
5. If needed, roll back to the Stage 1 image with compatible state and administration enabled. Review permissions before restoring a snapshot, because an older snapshot can restore revoked access. Do not disable administration or introduce an allow-all fallback.

The upgrade retains the existing schema version 3, database path, policy revisions, Passkeys, sessions, audit records, and `access_reviews`. The versioned migration from older supported schemas still runs, but never reads environment access IDs. Reconciliation GET/POST entry points and UI confirmation controls are removed. Historical reviews are read-only on **Audit → Import reports** and authenticated `GET /api/imports`; the API returns the latest 10 access review records.

## Policy behavior

To change inherited settings, use **Defaults**, **Tool permissions**, or **Model providers** for the relevant category. Existing chat overrides take priority within the global ceiling. In Defaults, select **Reset all chats to inherit defaults** and confirm to clear all tool, MCP server, allowed-model, model, and thinking overrides, including overrides outside the current chat page. This also replaces explicit empty lists with inheritance. Access approvals and chat enabled switches do not change. Review the defaults before you select **Apply policy changes**. Future chats inherit the same defaults unless given overrides.

Model validation errors identify **Defaults** or the chat ID, the model, and whether the allowed list is inherited. Open that section and add the model to **Allowed models**, or change the model selection. For an inherited allowed list, edit **Defaults** or clear **Inherit default** for that chat. Model conflicts also appear next to the selection before saving.

Global lists are availability ceilings. Global defaults select from those lists. Chat overrides can narrow or select within the ceiling, not exceed it. `Inherit default` and an explicit empty list have different meanings. An empty list allows nothing. The Chats workspace lists observed chats beside their details. Search, chat type, and access filters apply only to the loaded page. The obsolete known-chat dropdown has been removed. Its effective-settings summary uses the same resolver as the server, identifies inherited values and explicit overrides, and labels policy draft previews. Saved access and model values appear when policy drafts exist. Chat details use Overview, Access, Model & Tools, and History views. Access grants and revocations stage changes in the existing policy draft; they never enable a disabled chat. Model and tool overrides use the same policy save boundary, not separate per-field saves. Contextual links open global Access, model authentication, Tool permissions, and Audit. “Allowed” describes policy access only, not verified runtime readiness. Authentication configuration is not remote verification.

MCP server permission and individual tool permission are both required. `direct`, `codemode`, and `hidden` control exposure, not authorization. First discovery adds new tool names to global and shared-default permissions when space is available. Manual approval also works when discovery is unavailable. Explicit chat tool overrides, manual removals, and MCP server gates still apply.

Saving settings writes a revision and an audit record together. Runtime application cancels affected admitted work and closes cached sessions without deleting history. Current implementation rebuilds all cached chats for an administration change, not only the changed chat. An authorization epoch also cancels pre-change persisted work after restart, including MCP-only edits. New calls are denied while a revision is pending or failed. Completed external side effects cannot be reversed. Concurrent saves use one application worker. It applies the latest saved revision and does not install superseded provider settings. A failed application remains visible and can be retried.

| State | Enforcement |
| --- | --- |
| Unknown or denied chat | Reject before commands, attachments, callbacks, or passive context, except the narrow `/admin` and `/allow` bootstrap handlers. |
| Pending or failed revision | Deny new model and tool calls; keep administrator repair endpoints available. |
| Previously discovered tool | Recheck current authorization at execution, including calls through codemode. |
| Active work during application | Cancel queued and active work, close cached sessions, and retain transcript files. |
| Restart or branch restoration | Restore current model settings and enforce current permissions; do not replay withdrawn unsafe work. |
| External action already started | Cancellation cannot reverse an external effect. |

Configure providers, credentials, chat models, and thinking levels in the WebUI. Telegram does not provide `/model`, `/provider`, `/login`, or `/thinking`. `/reset` removes conversation state but not administrator-owned chat settings. Model requests, compaction, native tools, codemode's native tool calls, and MCP calls check current authorization.

## Navigation and chat details

The desktop sidebar links to Chats, Access, Defaults, Tool permissions, MCP connections, Model providers, and Audit. Existing `section=Model+Providers` links remain valid; `section=Model+providers` is also accepted. On narrow screens, use **Sections** to open navigation. The current section is highlighted. Within Chats, selecting a row opens its details; **Back to chat directory** restores the directory on narrow screens without clearing search or filters.

Section and selected-chat links use the existing root route with `section` and `chat` query parameters. Browser back and forward retain in-memory drafts. Reload retains the linked section and chat, but not unsaved drafts or directory filters. Chat names and types can be unavailable when the linked chat is outside loaded directory pages; this does not change access policy.

Chat details put known setup blockers and their actions before configuration. Directory badges say **Approved**, **Not approved**, and **Disabled**, with a **Draft** marker for policy previews. Approval is not a readiness claim. Details separate saved approval, the draft enabled switch, local configuration, remote verification, and runtime application. **Configured** means local configuration only. **Verified** requires a named successful remote check; chat model execution remains **Not checked**. **Applied** requires matching saved/applied revisions and a successful application. Policy approval is separate from runtime readiness. Missing authentication, unknown configuration, and unchecked remote availability have distinct labels. Overview uses compact effective-setting rows; technical details are expandable. Tabs retain the selected view when another chat is selected, and the content uses that chat's settings.

Names come from observed Telegram metadata or retained imports. Bootstrap records can contain only an ID. Chats and Access use the same fallback: `Unnamed <type> <ID>`. For unobserved IDs, the type is `private` or `group or channel`, based on the ID sign. The directory shows a single-line metadata ID; it does not fetch remote names on view. On desktop, the whole directory uses one viewport-bounded scroll area below the persistent save bar. Narrow screens use page scrolling. Administrator aliases require a backend storage and API change. There is no durable alias editor or client-only alias.

The History view shows only structured audit targets that exactly match `chat:<id>` in the loaded audit page. Global policy saves are recorded under `settings`, not attributed to individual chats. The API has no per-chat audit query. Use global Audit for pagination and broader context; an empty History view is not evidence that a chat has no changes.

## Save status and scope

The save/status bar stays visible while you scroll in all sections. It shows runtime application separately from pending browser edits. Each scope links to its editor; revision numbers and long change lists are expandable. At narrow widths, the bar has a bounded scroll area. It does not take focus when state changes.

| Scope | Save action | Other drafts |
| --- | --- | --- |
| Policy | Apply policy changes, then confirm Save and apply | Does not save MCP, credentials, or provider model previews |
| MCP | Save MCP configuration and apply | Does not save policy or provider drafts |
| Provider credentials | Save API key or explicit OAuth completion | Does not save model selection |
| Provider model | Save model availability or Save default model, then confirm | Does not save credentials, policy drafts, or MCP drafts |

Disabled controls have nearby reasons where setup or pending edits block the action. During a save, configuration controls are unavailable. Conflicts retain browser drafts. Session expiry clears sensitive drafts and requires sign-in. A failed application can follow a successful persistence operation: inspect saved/applied revisions before retrying. Reload is blocked by policy or unstaged edits, but retains staged MCP and model previews. Discarding policy changes does not discard those separate drafts.

Access tables search every ID in their policy list. Their counts distinguish matching draft approvals, saved approvals, and pending revocations. Name search uses only metadata loaded from chat pages; it is not a remote name lookup. Chat-directory search still covers only the loaded page.

Defaults summarizes saved and draft model, thinking, allowed-model, tool, and MCP defaults. Links lead to the existing authoritative editors. Bulk reset is unavailable when all chats already inherit defaults; saving also disables configuration controls. Explicit empty lists deny that category rather than inherit it.

## Audit filters and grouped records

Audit provides exact actor, operation type, and result filters plus inclusive UTC date bounds. They apply to all retained records on the server, not just the loaded page. The authenticated `GET /api/audit` endpoint accepts optional `actor`, `operation`, `outcome`, `from`, and `to` query parameters. Text filters contain 1–128 characters. Dates are non-negative integer Unix milliseconds; reversed bounds and duplicate filter parameters are rejected. The response remains an array, ordered by descending record ID, with 100 records per page and the existing bounded `offset` parameter. Unfiltered callers remain compatible. Live inserts can shift offset pages; reload to see the latest records.

Adjacent structured save/application records for the same revision and save target are grouped within the loaded page. Failed applications remain visible in the group summary; expand it for each record and raw data. Groups can continue on adjacent pages, and filters can omit related records. Login events and unrelated save targets stay separate. Historical field-level changes were not recorded; the UI does not invent a change diff. Filtering and pagination do not reload or clear policy drafts. Chat History continues to use the independent unfiltered loaded audit page.

## Tool permissions and defaults

**Tool permissions** is the only editor for global and shared-default tool and MCP-server permission lists. Its matrix has Tool/server, Global, Default, and Effective result columns. Effective results apply to inheriting chats only; explicit chat overrides remain separate. Blocked server gates and retained selections appear beside their controls. Tools are grouped by explicit inventory source: Built-in tools, each MCP server, and Unknown source. Each collapsible group shows its tool count and a compact permission list with shared column headings. Expand all and Collapse all control all tool groups. Expansion preferences are stored in this browser for the signed-in administrator; new groups start collapsed. If local storage is unavailable, expansion still works without persistence. Tool names shared by multiple sources appear in each source group and retain the existing shared, name-based permissions. Missing source metadata is shown under Unknown source, without guessing from tool-name prefixes. Collapsing a group does not change permissions or discard drafts. Detailed inheritance rules are expandable. Defaults shows saved and pending default counts within the global ceiling and links to `section=Tool+permissions#default-tool-permissions`. Per-chat overrides stay in chat details. The old `section=Tools+%2F+MCP` link opens Tool permissions.

- Global permission is a ceiling for every chat. Effective tool and server selections are the inherited or explicit chat list intersected with the global list. `null` inherits that category; an explicit empty list denies it. Default changes do not replace explicit chat overrides.
- Global removal does not delete default or chat selections. The existing backend rejects a policy save while any of those selections exceed the global list, including disabled chat overrides. The workspace shows retained selections and exact explicit-override references. Clear each conflicting selection explicitly or restore the global permission before saving. An unavailable, unselected default cannot be granted; a retained default can still be cleared.
- Counts describe default names within global permission, not working connections or executable MCP tools. MCP execution requires both the server gate and exact tool-name permission. First registration or discovery adds new tool names to global and shared-default permissions. This includes built-in tools at startup and MCP tools during connection tests or runtime discovery. Explicit chat tool overrides and server gates stay unchanged. A persistent first-seen registry prevents later discovery or restart from restoring manually removed permissions. On upgrade, existing selected names are retained without changes; other registered names are enabled. Automatic registration adds only names that fit within both 512-name permission lists. Overflow names stay unregistered and are retried on the next registration or discovery after space is available. Registration records an audit event and a new revision without cancelling active work; pending or failed application remains blocked. Exposure does not grant execution permission.
- **MCP connections** manages configuration, enabled state, masked secret replacement, explicit tests, and discovery. Its read-only permission summary identifies saved policy or policy drafts and links to Tool permissions. Viewing or navigating does not test connections or discover tools. Connection saves remain separate from policy saves.
- **Reset all chats to inherit defaults** stages removal of tool, MCP-server, allowed-model, model, and thinking overrides from every policy chat entry, including entries outside the loaded directory page. The confirmation counts entries with an explicit override. Access lists, chat-enabled switches, and shared defaults do not change. Explicit empty selections also become inherited. Use **Apply policy changes** to persist the reset.

## Editing scope and status

- **Apply policy changes** submits all pending policy edits across Chats, Access, Defaults, global capability lists, and custom endpoint configuration. Adding an ID or staging endpoint metadata does not save it immediately.
- **Save default model** submits the selected model and shared model/thinking defaults. With **Use as the bot default** cleared, **Save model availability** adds only the selected model to global availability. **Model providers** is the canonical shared default-model editor; Defaults links to it. Chat model overrides stay on Chats.
- **Save MCP configuration and apply** submits only the named connection and staged secret replacements. Credential actions save authentication separately. These operations are not one atomic transaction.
- The status shows whether saved settings are applied, waiting, or failed. Revision numbers remain under **Revision details**. Pending policy, MCP, and provider drafts have separate notices. Inputs are disabled during an operation to prevent concurrent local edits from being overwritten.
- Section navigation retains editor drafts. Reload is blocked by policy or unfinished editor input. Audit filtering and pagination are independent read-only queries and retain those drafts. Reload refreshes the current chat page as well as saved settings. Chat pagination and chat retries load only chat metadata and preserve policy and editor drafts. A chat request that returns 401 uses the same session cleanup as other API actions: the sign-in view replaces the editor, and sensitive drafts are cleared. Provider previews, MCP connection drafts, and staged MCP secrets survive a saved-state reload. Use **Reload** after a failed MCP save or deletion to inspect the saved revision and application status without discarding the draft. A failed response can follow a committed change. Browser reload or closing the tab warns about pending edits; sign-out requires confirmation. A browser warning cannot preserve drafts after the tab is closed.
- **Discard custom endpoint draft** resets the endpoint editor to its initial values. For a new endpoint, it clears the editor. It does not change staged policy edits or saved settings.
- Use the explicit discard action only when the pending edits are no longer needed. A failed save can leave a saved but unapplied revision. Reload the saved state, inspect its status, and use **Retry application** when available.

### Current API limits

- Chat search covers the loaded page of up to 100 observed chats, not the full database. The UI states this scope and provides Previous/Next controls. Pagination keeps the existing discovery order. The API does not support all-chat search. Direct ID configuration is a separate expandable form and does not grant access.
- Access search covers every ID in the selected policy access list, but names are available only for chat pages loaded in this session. Missing names show an explicit fallback. Successful sign-out clears cached chat names and IDs. After sign-in, names come only from pages loaded in the new session. Pending approvals and revocations remain visible; undo restores a staged revocation before policy application.
- The persistent status bar shows saved application state and each browser draft scope. With policy edits, it adds their count, review, apply, and discard actions. Its measured height sets the workspace scroll offset so focused controls remain below it. The pending-policy bar lists changes across sections. **Discard policy changes** restores the last loaded policy only; provider previews, MCP drafts, and unfinished editor input remain unchanged. Applied-revision status does not mean that browser drafts were saved.
- Search popovers and model, thinking, and advanced-setting dropdowns close when their section becomes inactive, including browser back/forward navigation. Escape returns focus to the trigger; section navigation does not restore focus to a hidden trigger. The obsolete chat selector has no remaining overlay or search state. Section editors and chat detail views remain mounted to retain drafts.
- Contextual **Grant access**, **Revoke access**, and **Undo pending revocation** change only the selected ID's explicit private-user or group/channel list. They do not write immediately, approve another scope, enable a disabled override, or authenticate a model. **Apply policy changes** still submits every staged policy edit across sections.
- Access history is read-only. The current API has no environment reconciliation or missing-ID approval workflow. Historical imports never approve IDs or restore revoked access. Access rows edit only the current explicit private-user or group/channel lists.
- Audit activity uses server offset pages of up to 100 records. The server retains at most 10,000 audit records and returns the latest 10 environment access reviews. The filters described above run on the server. There is no exhaustive client-side search.
- MCP inventory returns masked markers, not editable command, URL, or argument values. **Edit fields** starts an empty patch in the guided editor; enter only fields to change. Omitted fields are preserved. The advanced editor shows the same JSON patch. If an MCP draft exists, confirm its discard first. Typing a server name keeps the current JSON draft, including when an intermediate name matches an existing server. Omit `env` or `headers` to preserve that map. A supplied JSON map replaces the whole map: include every key to retain with `null`; omitted keys are removed. An empty map clears all entries. Masked replacements preserve existing keys when JSON omits that map. Connection tests enable first-seen tool names globally and in shared defaults; execution still requires the server gate and effective chat permission.
- Provider authentication availability is not remote verification. No remote check, authentication interaction, or billable model request starts automatically. Real device enrollment and provider acceptance require separate administrator checks.

## Model providers

Use **Model providers** for this flow:

1. Search for a provider. Built-in providers do not require endpoint IDs, URLs, or model metadata.
2. Select **Configure authentication**. A single supported method opens directly. If both methods are supported, choose account sign-in or an API key. Providers that use host credentials show setup guidance instead.
3. Review **Check status**. **Check authentication** checks local credential availability only. Remote model verification stays **Not checked**. Explicit custom model discovery can show a verified model-list request or a failed check; neither proves model execution works.
4. Search for a model. The page shows reasoning and image support. Thinking choices contain only supported levels.
5. Optionally select **Use as the bot default**. This changes the model and thinking defaults for chats that inherit them. Chat overrides stay unchanged. Each chat must allow the new model.
6. Select **Save default model** or **Save model availability**, as applicable, then confirm. This adds only the selected model to global availability. It does not grant the full provider catalog or change tool, MCP, or user access. Check the saved and applied revisions under **Revision details**.

Provider setup loads the shared bot default, model, and thinking level from the current settings. If there is no shared default, one common explicit chat model can fill the form without becoming a shared default. When chats use different models, the page lists their overrides and does not choose one model arbitrarily. A common provider can still fill the provider field. Unavailable saved providers and models remain visible; no replacement is selected automatically.

Reload updates untouched fields. An explicit local preview stays intact during reload and credential refresh. Select **Use saved selection** to discard that preview and load the latest settings. An unchanged selection cannot be applied again. Changes to model selection stay in the browser until confirmation. Credential changes are saved separately. Authentication refresh retains the selected model; an unavailable model stays visible and cannot be saved. Save or discard other unsaved policy edits before changing credentials or applying a model. Revision conflicts retain the model selection and report an error. Reload the latest revision before retrying.

For a public compatible endpoint, open **Custom endpoint**. Enter its provider ID, base URL, and model ID. Open the advanced controls only to change the protocol or model metadata. The initial values are OpenAI Completions, text-only input, no reasoning, a 128,000-token context window, and an 8,192-token output limit. These are editable configuration values, not discovered capabilities. Confirm them against the endpoint documentation. Use **Add / update model** for multiple models, then **Set provider configuration** and the shared **Apply policy changes** confirmation. Authenticate the endpoint after its saved revision is applied.

Supported custom API types are OpenAI Completions, OpenAI Responses, Anthropic Messages, and Google Generative AI. Administration policies select physical chat models, not virtual routers, classifiers, or image-generation models. Model IDs may contain slashes; provider IDs cannot. **Manage model availability** lists only approved models. Add other models through the provider flow, not by granting a catalog.

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

Only the administrator can change MCP commands, endpoints, environment fields, headers, timeouts, and exposure rules. Starting a configured stdio server executes administrator-supplied code. Connection tests can therefore have startup effects even though they do not invoke tools. Stdio connection tests use the bot working directory, including as the base for a relative server `cwd`.

Use **Delete** beside an obsolete MCP entry to remove its configuration and stored secrets, then apply the change. First remove that server from global availability, defaults, and explicit chat selections. Deletion checks the saved revision, records an audit event, and frees one of the 16 server slots. A running connection test blocks deletion. Transcript files remain unchanged.

Session creation checks the saved revision before MCP discovery. Each transport start also checks the current authorization epoch, including after asynchronous process-home setup. A revoked chat, server, or configuration cannot start a stale MCP command.

The guided MCP editor comes before advanced JSON. Both edit the same patch; the API does not return saved command, URL, argument, or secret values. **Edit fields** starts an empty patch and focuses the guided editor. Select only fields to replace. Advanced JSON supports secret-map operations and per-tool exposure. Invalid or unknown fields remain available in JSON for correction; they are not silently discarded.

The preview lists field operations before saving: set/replaced, added, removed, cleared, and preserved. It shows field names, not values. Inventory exposes only configured top-level field names for this preview. The server remains the final validator. A command or URL replacement with omitted `type` clears the stored transport type and infers it again. HTTP selection removes command, arguments, working directory, and environment fields; stdio selection removes URL and headers. Preview these removals before saving. Tests and discovery remain explicit; stdio startup can have side effects.

MCP configuration supports the existing transport fields. An update preserves omitted fields. For `env` and `headers`, null preserves a named value, a literal replaces it, and an empty object clears the map. Use these maps for secrets; do not put secrets in commands, arguments, descriptions, names, or URLs. Ordinary inventory responses show configured markers and field names, not existing secret values.

MCP may depend on private Docker endpoints. Existing MCP HTTP protections remain separate from the public-only custom model provider policy; do not assume MCP endpoints are public-only. Redirects never forward administrator credentials.

## Trust boundary

Tools are capabilities, not an OS sandbox. Pi, shell tools, and stdio MCP processes run with the container user's permissions. A working directory does not confine file access. A shell or file tool can read process-readable state, modify policy or credential files, and reach the network without using another named tool. Administrator-supplied MCP code has the same trust requirement.

Shell tools receive a restricted environment: system and runtime paths, locale fields, and the existing Otter and Firecrawl skill credentials. They do not directly inherit bot tokens, unused legacy Telegram login secrets, or ambient model provider keys. MCP retains its existing explicit environment policy.

Sumire does not inject stored model provider credentials into tool or MCP environments, but same-user file access is not isolated. Do not enable shell or unrestricted file tools for untrusted chats. Do not claim credential isolation when these capabilities are enabled. Use a separate tested OS or VM boundary if that isolation is required. This release does not add such a boundary.

## Backup and recovery

Before enabling the WebUI or changing versions:

1. Stop ingress traffic and stop the bot from the repository root.
2. Back up the state volume, source MCP configuration, and bootstrap secrets with restricted access. Include Pi's `auth.json`, model store, and all session SQLite files and their SQLite sidecar files. Never commit this backup.
3. Start the selected application version, inspect the import report and effective policies, then reopen ingress.

Use a consistent SQLite backup or a stopped-service volume snapshot, not an unsynchronized copy of a running database. To recover from an incorrect administrator ID, use trusted host access to correct `BOT_ADMIN_ID`. The migration to schema version 2 preserves policy and transcript state, drops pending Telegram login transactions, and revokes old Telegram sessions. Older binaries refuse this schema; rollback requires the matching database backup. Schema version 3 adds pending chat approval requests and environment review records. Upgrading from version 2 retains policies, Passkeys, and administrator sessions. Version 2 binaries refuse the new schema; restore the matching pre-upgrade database for rollback. Pending links and review records from the newer deployment must not be copied into an older backup. To revoke all administrator sessions while stopped, delete rows from the administration database's `sessions` table using a trusted SQLite tool. Do not delete the database to log out: that would discard policies and trigger import again.

If all copies of the passkey are lost, stop the bot and back up state. Use a trusted SQLite tool to run this transaction on `admin.sqlite`:

```sql
BEGIN IMMEDIATE;
DELETE FROM passkeys;
DELETE FROM passkey_setup;
DELETE FROM passkey_challenges;
DELETE FROM sessions;
COMMIT;
```

Restart the bot, then send `/admin` from the configured administrator's private chat to register a new passkey. This removes all administrator credentials and sessions, but retains policies, provider settings, audit records, and transcripts. Do not edit the live database while the bot is running.

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

After building, `node apps/bot/scripts/check-admin-local.mjs` runs a real Chromium test against the local HTTP server. It checks virtual-authenticator registration and sign-in, Secure cookies, CSRF rejection, logout, pending-request reload, explicit chat approval, and database-only access. It uses temporary state and no live Telegram or provider requests. Chromium must be installed through Playwright.

`node apps/bot/scripts/check-admin.mjs` runs an offline HTTPS smoke test with temporary certificates and state. It checks production assets, session and CSRF enforcement, logout cookies, restart persistence, and the absence of same-user file isolation. It does not use real bot credentials or contact Telegram or providers. In Compose, use an isolated test override with no environment file, persistent volumes, published ports, or external network.

The browser suite uses API fixtures and a strict-port development server. It includes a Chromium virtual-authenticator registration and sign-in flow. It does not prove real device enrollment, real provider OAuth, or public TLS. For a local authenticated session, use the production build at the default localhost origin. For remote access, use the configured HTTPS origin. Keep Secure cookies and all authentication checks enabled.

Before production acceptance, verify real device registration and passkey sign-in on the configured domain, rejection of unauthorized setup and login, provider authentication with the selected providers, revocation during active work, restart persistence, backup restoration, and HTTPS ingress behavior. Real device and provider tests require the administrator and deployment access; do not substitute fixtures for this evidence.
