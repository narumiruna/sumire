# Administration WebUI

The WebUI manages chat access, tools, skills, MCP servers, models, thinking levels, model providers, runtime secrets, and variables. It uses React, Radix Themes, Radix Primitives, Radix Colors, and Radix Icons. The bot serves the frontend and API from one origin.

## Interface language

Use **Language** on the sign-in screen or in the sidebar to select **English**, **正體中文**, or **日本語**. The selection takes effect without reloading the page or discarding editor drafts. It changes presentation only and does not save or apply service settings.

The WebUI stores an explicit choice in this browser as `sumire.admin.locale`. On the first visit, it uses the first supported browser language. English, Chinese, and Japanese language tags select `en`, `zh-TW`, and `ja`; all Chinese variants use Traditional Chinese. Other languages fall back to English. If browser storage is unavailable, selection still works for the current page. At narrow widths, open **Sections** to access the selector.

Chat names, messages, tool output, provider metadata, skill descriptions, server diagnostics, and raw JSON remain in their original language. Technical IDs, API values, URLs, and saved policies do not change. Telegram bot messages are not part of this setting.

Translation catalogs are in `apps/admin/src/locales/`. Each stable key has English, Traditional Chinese, and Japanese text with the same interpolation fields. Add presentation text through `t()` in `apps/admin/src/i18n.ts`; keep protocol and policy identifiers outside the catalogs. Resolve translated labels when rendering or calling a presentation helper, not at module initialization.

## Workspace layout

The flat navigation order is **Chats**, **Conversation logs**, **Shared defaults**, **Providers & models**, **Tool permissions**, **Skills**, **MCP servers**, **Secrets & variables**, **GitHub mentions**, and **Audit log**. Existing section IDs, aliases, anchors, and selected-chat URLs remain valid. There is no notification settings page in this build. Telegram lifecycle notices are a separate feature, not a polling-service dashboard.

The sidebar account menu contains **Sign out** at desktop and narrow widths. First-level pages have one title, a necessary description, and actions; they have no breadcrumb. **Refresh settings** refreshes configuration and related metadata. **Refresh records**, **Refresh chats**, and **Reload safe metadata** retain their separate read scopes. Page changes do not save settings. Editors remain mounted where needed to retain ordinary drafts; secret editors keep their existing navigation guards and clear sensitive state on expiry/sign-out.

Body and input text use 16 px at the default browser size. Navigation and primary list text use 15–16 px; help and secondary metadata use 14 px. Relative text sizes support browser font enlargement. Primary controls retain at least 44 px targets. Forms use a bounded reading width; data lists use the content width. Sections put their title and necessary context before controls rather than reserving a wide explanation column. Keyboard focus remains visible above the fixed changes bar.

- **Chats** shows the directory or the selected detail, not an unused half-width pane. Rows separate access, effective model, saved configuration issues, and actions. Names are native detail links; IDs have copy actions. Common access and repair actions are visible; destructive revocation stays in the row menu. Back retains filters, selection, scroll, and row focus. Local configuration never proves successful model execution.
- **Conversation logs** uses an approximately 300 px desktop chat directory beside the existing reader. Narrow screens use **Find or switch chat**. The unselected state explains the next action. **Read-only**, History, Branch view, and Event details retain the existing bounded reads, deep links, role distinctions, collapsed tool payloads, and loaded-page-only search. Selecting a chat does not load its runtime session.
- **Providers & models** starts with configured or policy-referenced providers. Saved references remain visible during unrelated draft edits. Add provider opens the catalog or explicit custom endpoint setup. Detail contains Connection, Models, and Usage policy references. Usage links lead to Shared defaults or the chat editor; they do not duplicate those editors.
- **Shared defaults** keeps inline model/thinking controls, an explicit allowed-model disclosure, and capability counts with management links. Explicit chat overrides remain unchanged. The confirmed bulk reset remains under Advanced actions.
- **Tool permissions** keeps Global policy, Shared defaults, and the selected-chat entry visible. Configured selections and effective results identify blocking sources and repair actions. Scope/pending counts include filtered names. The selected-chat entry opens the existing category editor: `null` inherits; an explicit empty list denies that category. There is no independent per-tool inheritance model.
- **Skills** uses compact purposes and full-description details. **Installation instructions** explains trusted-host file maintenance; the WebUI does not install or delete skill files. That dialog closes on section/history changes without focusing a hidden trigger.
- **MCP servers** uses compact rows and separate connection details. **Test & discover** is one explicit operation. Configured enabled state, a connection observation, published names, and execution permission are separate facts. Editing remains a masked patch; closing retains the draft.
- **Secrets & variables** puts tabs, search, Add, and saved rows before optional GitHub connection details. Create, replace, keep unchanged, and delete are separate actions. GitHub mentions opens the same on-demand connection panel and shared credential store.
- **GitHub mentions** shows the saved author policy, known local blockers, prior account metadata, and application state before the editor. Draft author changes do not repair saved state. Worker and delivery health are not measured by the connection metadata endpoint.
- **Audit log** retains exact server filters and grouped records. Actor, time, target, result, and revision are available; historical field diffs were not recorded. It is separate from conversation/tool content.

## Model setup save boundaries

1. Connect a provider through its API-key or OAuth action. This saves credentials only. Local credential availability is not remote verification.
2. Add one model through **Save model availability** and its confirmation. Only global availability changes. Selecting a provider does not grant its catalog or set a default.
3. Open **Shared defaults** or a chat's Model & Tools editor to choose model use, then review and save the policy transaction. Shared-default edits do not replace explicit chat overrides.

Policy review includes every staged policy edit across pages. MCP saves, credentials, availability additions, and runtime-value writes remain separate operations, even though they share revision checks. Saving immediately attempts application; Retry application does not repeat persistence. Application can cancel active work. Discard cannot undo committed writes, completed authorization, or external actions.

See [workflow validation and external handoff](admin-workflow-redesign-validation.md#2026-11-05-interaction-structure) for current evidence and release limits. Earlier sections in that document are historical results.

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

To change inherited settings, use **Defaults**, **Tool permissions**, **Skills**, or **Model providers** for the relevant category. Existing chat overrides take priority within the global ceiling. In **Shared defaults → Advanced actions**, select **Reset all chats to inherit defaults** and confirm to clear all tool, MCP server, skill, allowed-model, model, and thinking overrides, including overrides outside the current chat page. This also replaces explicit empty lists with inheritance. Access approvals and chat enabled switches do not change. Review the defaults before you select **Review and save changes**. Future chats inherit the same defaults unless given overrides.

Model validation errors identify **Defaults** or the chat ID, the model, and whether the allowed list is inherited. Open that section and add the model to **Allowed models**, or change the model selection. For an inherited allowed list, edit **Defaults** or clear **Inherit default** for that chat. Model conflicts also appear next to the selection before saving.

Global lists are availability ceilings. Global defaults select from those lists. Chat overrides can narrow or select within the ceiling, not exceed it. `Inherit default` and an explicit empty list have different meanings. An empty list allows nothing. The Chats workspace lists observed chats beside their details. Name and complete-ID search apply to the stored directory before pagination. Chat type and access filters apply only to the loaded page and can preview policy drafts. The obsolete known-chat dropdown has been removed. Its effective-settings summary uses the same resolver as the server, identifies inherited values and explicit overrides, and labels policy draft previews. Saved access and model values appear when policy drafts exist. Chat details use Overview, Access, Model & Tools, and History views. Access grants and revocations stage changes in the existing policy draft; they never enable a disabled chat. Model and tool overrides use the same policy save boundary, not separate per-field saves. Contextual links open access management within Chats, Model providers, Tool permissions, and Audit. A model conflict has a **Review allowed models** action that opens the relevant disclosure. It does not change permissions. “Allowed” describes policy access only, not verified runtime readiness. Authentication configuration is not remote verification.

MCP server permission and individual tool permission are both required. `direct`, `codemode`, and `hidden` control exposure, not authorization. MCP discovery records names without enabling them. Approve exact tool names explicitly in Tool permissions; configuring a credential does not grant access. Manual approval also works when discovery is unavailable. Explicit chat tool overrides, manual removals, and MCP server gates still apply.

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

## Presentation

The app uses an explicit light appearance, including when the operating system prefers dark mode. Dark mode is not supported in this presentation pass. Teal identifies links and navigation controls; destructive controls have a visible boundary. Shared panels use one border, radius, spacing, and heading rhythm. Paragraphs have a maximum measure of 72ch. Control groups retain fieldset semantics without a border notch. Selectors use the section-aware Radix control; date fields retain native date semantics within Radix text fields.

Each section has an error boundary. A malformed record shows a local error and a retry action, not a blank app. Navigation, the save bar, and other sections remain available. Chat History has its own boundary, independent of Audit. Retrying a display does not submit a mutation.

## Navigation and chat details

Navigation is flat. Legacy `section=Access` opens Chats, expands access management, and focuses approval. `Defaults`, `Durable`, and `MCP connections` section IDs remain unchanged; both Model Providers aliases remain accepted. Narrow screens use **Sections** and retain the selected-page highlight. The sidebar account menu contains Sign out. Back to chat directory restores filters, selection, scroll, and focus. Copy chat ID is available in both rows and details.

Section and selected-chat links use the existing root route with `section` and `chat` query parameters. Explicit chat choices create browser history entries. Browser back and forward retain in-memory drafts. Reload retains the linked section and chat, but not unsaved drafts or directory filters. An exact directory lookup resolves the selected chat's name independently of the visible page. Loading, unknown metadata, permission denial, and read failure have separate states; none changes access policy.

Directory rows and chat details share one saved-state summary: **Access not approved**, **Disabled**, **Application failed**, **Application pending**, **Setup required**, **Status unknown**, or **Configured locally**. Each row shows a compact primary-state badge; its reason remains in chat details and the badge title. Names have priority over type and ID. Accessible row names include the full ID, and details retain Copy chat ID. Matching authentication issues appear once per provider above the directory, with counts limited to the displayed page. Details provide a repair action above the tabs and keep additional issues under **Readiness details**. Priority is access restrictions, application state, model setup, then missing inventory information. Repair actions select and focus the relevant editor, heading, or save status; they do not save or retry automatically. Approval and the enabled switch are separate facts. Detailed **Configured locally** summaries state **Model response not checked**; no existing inventory field proves successful model execution. **Applied** requires matching saved/applied revisions and a successful application. Draft effects appear separately and cannot repair the saved-state claim. Overview and editors label **From shared defaults** or **This chat override** beside each affected field; global availability still limits both. Tabs retain the selected view when another chat is selected, and the content uses that chat's settings.

Search is above the chat list and scrolls with the page. Wide directory rows separate Chat/ID, Access, Effective model, Configuration issues, and Actions; narrow layouts stack those fields. Common access/repair actions are direct; destructive Revoke access stays in the menu. Opening a menu does not select the chat or save settings. Saved approval and draft access remain distinct. Conversation logs retains the selection-only directory without access actions. **Filters and search scope** contains Chats type/access filters and detailed search rules. Search covers the stored directory before pagination; type/access filters cover only the loaded page. The access filter remains draft-aware; saved status and access labels remain separate from the explicit **Draft access** line. Pagination is hidden only on the first successful page with fewer than 100 records. Loading and errors do not establish that condition, and later pages always retain Previous chats. Exactly 100 records can require an extra empty page because the API has no total count.

Names are backend-persisted in `.telegramagent/admin.sqlite`, keyed by stable Telegram chat ID, independently of Pi sessions. Chats, access management, and Durable share a name resolver. Known names take priority; unknown names use `Unnamed <type>`, with the ID shown separately. A selected ID absent from the directory has an unknown-name state, not a loading or read-failure label. The directory never fetches remote names or starts sessions. Private display names use observed first and last names. Valid title/name changes replace the stored value; missing, blank, and ID-only observations do not erase known names. Inferred startup/import records and delayed approval metadata only create missing rows and cannot replace existing observed metadata. Chats uses page scrolling at every width, without a separate directory scrollbar. There is no client-only alias editor.

The previous startup path passed the chat ID as a name to an unconditional upsert. This replaced known names and could replace `supergroup` or `channel` with inferred `group`. The correction keeps schema version 3 and needs no migration. Existing ID-only and blank records remain readable. No verified, current, independent source can safely reconstruct overwritten names from tracked storage contracts, so there is no automatic backfill. Future Telegram observations restore names. Do not scan message bodies, query every Telegram chat, or open Pi sessions for name repair.

The History view shows only structured audit targets that exactly match `chat:<id>` in the loaded audit page. Global policy saves are recorded under `settings`, not attributed to individual chats. The API has no per-chat audit query. Use global Audit for pagination and broader context; an empty History view is not evidence that a chat has no changes.

## Durable Inspector

Open **Conversation logs** directly and use **Find or switch chat**, or use **View conversation records** from Chats. The shared selector searches names and complete numeric IDs across the bounded stored directory, with 100 matches per page. It is not a search of all Telegram chats. **Open chat settings** is a secondary route to the selected chat's configuration. Deep links retain `section=Durable`, `chat`, `view`, and optional conversation, task, scope, and object IDs. A chat change clears previous-chat inspector context and cursor state. Refresh and browser back/forward restore the linked selection. Moving between sections preserves policy drafts and the existing discard confirmation. Old query, metadata, and inspector responses cannot replace the current chat.

**History** is the default reading view. Without an explicit conversation ID, it uses only the persisted selected conversation; a missing selection never falls back to the first row or an active marker. Each page contains at most 25 saved entries. Native pagination starts with the latest entries; the reader reverses each page into creation order, not timestamp order. **Older records** and **Newer records** change pages. Groups start only at native `pi.user` entries; passive context and compaction do not create user turns. Leading entries are labeled **Earlier context on this page** because their preceding turn can be outside the page. Inherited entries retain their origin conversation ID and are labeled accordingly.

**Search loaded page** and **Record type** filter only the bounded page, including its captured thinking and tool content. Counts identify matching and loaded records, not complete history. User and assistant text appear inline; thinking, tool arguments, and tool output start collapsed. Selecting **Inspect entry** opens **Event details** beside the list on desktop or in a focus-trapped dialog on narrow screens. Escape closes the dialog and returns focus to its opening link when available. Selection keeps the history page and filters. Detail reads use the inspected conversation's ancestry, even for an inherited entry. A selected record outside the page or filters is labeled rather than inserted into the list.

History is saved model-facing entry content, not a complete Telegram archive or a captured provider request. It does not apply head ranges or context edits to reconstruct model input, expose arbitrary internal payloads, or recover uncaptured information. Empty, omitted, truncated, unavailable, and failed content have separate labels. Read times identify independent history and detail reads.

Read the context first: the chat name, inspected conversation, whether it matches the persisted selected conversation, and available parent/fork and owner relationships. This context stays visible in Tasks, Documents, and Entries. The inspected conversation is separate from the server's persisted selection; inspecting a historical branch never changes that selection. Related-record links name their destination. Opening Tasks, Documents, or Entries keeps the inspected conversation as its target, including a conversation selected on a later page. Missing persisted-selection metadata is reported as unavailable, not inferred from the first conversation row.

**History and context** contains persisted session context and one bounded page of task history for the persisted selected conversation. It is collapsed below the primary workspace and remains separate from the records of the inspected conversation. Task status/outcome describes stored observations, not current execution, scheduler health, or response delivery. Counts refer only to the loaded page. Missing metadata, an empty page, a withheld value, an unavailable record, and a failed read have separate explanations. The read-only history warning and each block's read time appear beside the relevant data; the page is not an atomic snapshot.

**Branch view** connects loaded conversations, child tasks, entries, and document collections in a relationship navigator beside the selected record. Use **History** to read the inspected conversation without changing the bot's persisted selection. Expand controls and record links are separate: expanding reads the relevant bounded collection; selecting inspects the record without changing persisted selection. Expand a conversation to read one task page and one entry page. Expand document collections separately. Missing parents and cycles stay visible at the root; branches outside loaded pages are not inferred. Each collection has its own loading, error, incomplete, and pagination controls. Counts identify loaded conversations, not a complete record count.

On narrow screens, **Browse records** starts closed. Selecting a record closes navigation and moves keyboard focus to the loaded detail heading. Reopening navigation preserves expanded branches. Native modifier-click behavior and deep links remain available. Visual indentation is capped for deep branches without changing their semantic nesting or hiding records. On desktop, navigator height does not stretch the selected record.

The selected record shows its title, identity, available date, and content or approved document fields first. Role colors and icons identify record types; a separate marker identifies the inspected record. Colors do not imply live execution. Ordinary messages use the body font with preserved whitespace; tool output and arguments use monospace. Thinking remains collapsed. Content is literal text, not executable HTML.

**Record details** contains the full relationship and metadata fields. **Raw data** contains copyable metadata, entry-content, or approved-value JSON. Both start collapsed. Copy actions retain their manual-copy fallback. **Raw collections** contains the object tabs, metadata lists, scope selectors, and page controls; it does not repeat the selected list below normal content. Labels use structured metadata only and do not invent conversation titles, task descriptions, or message previews.

**Advanced inspection** provides direct Conversation ID lookup in Conversations and conversation/task scope IDs in other views. A Conversation ID lookup in Conversations retrieves that record with `objectId` and sets the inspection target, not the persisted selection. Related links, tab changes, and object deep links keep that target. Refresh resets pagination and local row selection; an explicit object deep link remains on that object. Browser back/forward between History entries retains the loaded page and filters. A different conversation or raw-object context starts at the first page. **Data scope and limits** contains the full limitations.

The Inspector is read-only and works only with an already loaded chat session, whether running or idle. **Not loaded** means no session is available for inspection. Viewing or refreshing does not open a database, authenticate a provider, start MCP, restore a branch, resume work, call tools/models, or deliver Telegram responses. It does not grant chat access. There are no execution or mutation controls.

| View | Displayed data |
| --- | --- |
| History | Bounded saved model-facing content in user-turn groups, loaded-page filters, ancestry-limited older/newer pages, and explicit Event details. Not a reconstructed request or Telegram archive. |
| Conversations | Inspected and persisted-selection context, parent/fork point, and named owner/task links. Selection is not running work. |
| Tasks | **Model response** for `pi.generation`, **Tool call** for `pi.tool`, **Compaction** for `pi.compaction`, and **Task** for all other kinds. Show the recorded outcome when present, or the stored status with an explicit absent-outcome explanation, owner links, and available start/end dates. An absent outcome means no outcome is recorded, not success. Nonterminal status is a stored observation, not a live execution claim. |
| Documents | Readable kind/scope labels and, after explicit document inspection, approved values as labeled fields. Technical details retain family membership and commit sequences. Created/retired sequence numbers identify commits, not dates. |
| Entries | Entry kind, role, tool name and result status when recorded, available date, and named task/head links. Explicit entry inspection adds bounded message text, thinking, tool arguments, and tool results. Images show MIME metadata only. |

Task `startedAt` and `endedAt` and entry `timestamp` use Unix milliseconds. Available dates and block read times use readable ISO UTC formatting. Missing dates remain unavailable; they are not replaced with the current time. Document `createdAt` and `retiredAt` are commit sequence numbers and are never formatted as dates. Unknown task kinds retain their internal kind in technical details without an inferred meaning.

Only version 1 of these singleton document projections has value access. After an explicit document detail read, the approved projection appears as labeled values without requiring JSON:

- `pi.agent`: model provider, model ID, and thinking level. Instructions, working directory, credentials, and provider session identity remain hidden.
- `pi.usage`: aggregate numeric usage, with per-model values in expandable groups. Values include input, output, cache-read, cache-write, total tokens, and corresponding reported costs when present. Opening a model group does not make another request. Aggregate values include numeric tool contributions without tool names or payloads. Missing numeric fields show **Not recorded**, not zero; empty usage is not proof of zero usage.
- `sumire.session`: the active-conversation reference, with a named link to inspect that conversation. The session ID and trust key remain hidden. An absent reference does not select a fallback conversation.

Unknown kinds, family members, task-scoped values, codemode stores/journals, and outbox content are withheld. Metadata JSON does not include arbitrary object fields. A withheld value is different from an unavailable value: the latter can follow task completion, retirement, or a missing object in the selected scope. Current reads do not reconstruct retired task documents or provide an exhaustive journal archive. An uninspected document remains metadata-only; it is not labeled as withheld or unavailable. Document fields use only the approved projection. Document values still require explicit inspection. Entry content is separate from document values and metadata JSON. Tool results and user messages can contain sensitive data; restrict administrator access and clipboard use. Content is shown as text, not executable HTML.

Refresh is manual; there is no polling or subscription. Outside tree expansion, each context change or refresh reads at most three inspector pages in sequence: one conversation page with a selected-conversation projection, one task-history page if selection is known, and the requested inspection page if not already read. Selecting a History entry makes one additional scoped entry-detail read without reloading its page. UI pages contain at most 25 records. Tree expansion makes additional bounded reads only for the expanded collections. It never scans all pages or all documents for a summary. Partial failures leave successful blocks available. **Previous objects** and **Next objects** use chat/query-bound continuation tokens. Refresh returns to the first page. Cursor tokens expire when their loaded owner is replaced; refresh after a reset, policy application, or session close. Context and raw-record panels show their read times. Tree collections are separate reads, not an atomic snapshot. Records can change or retire between pages; refresh to read the new state. Separate reads are not one atomic cross-object snapshot.

### Inspection API and limits

Authenticated `GET /api/chats/:chatId/durable` accepts `view=conversations|tasks|documents|entries|history`, `limit`, `cursor`, and optional `objectId`. Tasks, entries, and history require `conversationId`. Documents require `scope=session|conversation|task` (default conversation); conversation scope requires `conversationId`, task scope also requires `taskId`, and session scope excludes those IDs. Document values require an explicit `objectId` detail read. The `entries` list remains metadata-only; `history` adds bounded content to each returned entry. Entry/history `objectId` reads share the same ancestry gate and content projection. History scans exactly one native page in newest-first creation order, including ancestors only through their inclusive fork points. It retains each entry's original conversation ID and does not apply context edits or head-range reconstruction. IDs are resolved only in the selected chat and verified against the selected scope/entry ancestry. No route accepts a database path, SQL, arbitrary document address, or write operation.

- Loaded conversation responses add optional `selectedConversation` metadata, independently of the page: an object for an available persisted selection, or `null` if no selected conversation is available. Older responses without the field show selection unavailable rather than inferring a first-row selection. At most one targeted conversation read supplements the page; no transcript or arbitrary document fields are added.
- Pages default to 25 and allow at most 100 records. Encoded cursors are limited to 4 KiB; projected responses to 256 KiB; projected strings to 16 KiB. Entry content is limited to 128 KiB, 256 messages, 256 content blocks, and 16 KiB per text or argument field. Tool names, call IDs, and MIME types inside content are limited to 1 KiB. Truncation is explicit; a truncated argument field is a text prefix, not a complete JSON object. The response itself remains valid JSON. Entry data, tool details, protocol signatures, and image bytes are excluded. Fixed-schema document projections remain below depth 12.
- Entry/history cursors retain a maximum entry ID so newer appends do not shift overflow replay offsets. Refresh includes newly appended entries. Tokens remain bound to the chat, view, scope, limit, and loaded owner; they do not establish an atomic snapshot.
- One inspection read per chat is admitted at a time. Session creation, reset, recovery eviction, policy invalidation, and shutdown coordinate with the same storage owner. A changing/busy owner returns a read error; refresh after the change finishes.
- Requests expire after five seconds or the remaining administrator-session lifetime, whichever is shorter. Disconnect/shutdown also cancels the request. Authentication is checked again before delivery; expired/revoked sessions receive no object data and the frontend clears its Inspector state.
- **Native allocation limit:** public Pi Storage scans materialize complete task/entry records, and an approved `document()` read materializes its complete value before projection. Response limits do not bound that native allocation. Cancellation cannot interrupt synchronous SQLite/JSON work. The read lease remains held until the underlying read actually settles; a deadline does not release it early or allow storage to close underneath it.
- API errors are sanitized. Invalid filters/cursors return 400, missing/unavailable document details 404, owner conflicts 409, deadline cancellation 408, oversized metadata 413, and failed reads 503. Session expiry returns 401. No raw payload, SQL, or database path is included in an error.

The feature adds no durable schema migration. Roll back the matching bot, admin, and contracts build together after inspection reads drain. Do not abort agent work or restore an older database snapshot for a display-only rollback. See [chat-centered Durable validation and rollout handoff](chat-centered-durable-validation.md) for earlier regression evidence, screenshot artifacts, and name-recovery limits. [Conversation History validation](conversation-history-validation.md) records the History checks and remaining deployment review.

## Save status and scope

When every browser draft and unfinished input is clean, no operation is active, and saved/applied revisions match with successful application, the bar shows **Settings saved and applied** plus optional revision details. This describes persistence and application only. Chats, Shared defaults, and Model providers show separate, scoped model-setup information. Missing credentials require authentication; missing inventory means unknown status. Local configuration does not prove model execution. It omits draft-scope notices and save help. Clean, fully applied Conversation records views continue to hide unrelated save/revision controls.

Any policy, MCP, provider, or unfinished editor draft, active operation, or pending/failed application keeps the full bar visible, including retry and draft actions. One badge shows the current operation, failed or pending application, pending policy count, or applied state, in that order of priority. Only pending scopes have editor links. Each unfinished input names its page and field. **Continue editing** opens its page and disclosure, then focuses the input. Clear actions remove only that input; endpoint discard restores the initial form. Policy review entries open the changed section or chat, not a fixed Access page. Revision numbers stay under **Revision details**. **Review and save changes** opens one review with changed fields, affected scopes, and links to their editors. It covers this chat only, chats inheriting each changed default, or global availability including explicit overrides. General change summaries omit selection values. Shared-model review also shows the previous and proposed model plus each added shared allowed-model reference. Credentials and endpoint values stay excluded. It does not invent an exact affected-chat count. The same review retains the active-work and revocation warnings. **Save changes** confirms the transaction. Cancellation retains the staged changes. Unfinished input blocks confirmation and includes an action to return to its editor. At narrow widths, the bar has a bounded scroll area. Status updates do not take focus; an explicit repair action can focus the bar.

| Scope | Save action | Other drafts |
| --- | --- | --- |
| Policy | Review and save changes, then confirm Save changes | Does not save MCP, credentials, or provider model previews |
| MCP | Save connection | Does not save policy or provider drafts |
| Provider credentials | Save API key or explicit OAuth completion | Does not save model selection |
| Provider model addition | Save model availability, then confirm | Does not save credentials, policy drafts, or MCP drafts |

Disabled controls have nearby reasons where setup or pending edits block the action. During a save, configuration controls are unavailable. Conflicts retain browser drafts. Session expiry clears sensitive drafts and requires sign-in. A failed application can follow a successful persistence operation: inspect saved/applied revisions before retrying. Reload is blocked by policy edits, unstaged input, or an unresolved policy-save outcome, but retains staged MCP and model previews. Discarding policy changes does not discard those separate drafts.

### Recover a failed policy save

1. Select **Load latest and review draft**. This reads saved settings without discarding local edits or waiting for inventory and audit reads. It verifies the policy, revision numbers, and application status before opening the review. It does not write settings. Another policy submission is blocked until the failed attempt has been read and reviewed.
2. Inspect **Review recovered settings draft**. Unedited fields keep their latest saved values. Non-overlapping local edits are retained; matching values show **Already saved**.
3. Resolve each overlapping change with **Keep saved value** or **Use draft value**. Expand **Compare values** to inspect saved and draft values. Permission/access lists, the ordered provider list, and each chat override are atomic values; choosing a draft replaces that whole value. Shared-default fields are compared separately. Lists are never combined automatically.
4. Select **Use recovered draft**. This adopts the latest revision as the save base and opens the existing settings review if changes remain. Finish any unrelated unfinished inputs before confirmation. Cancellation or a failed settings read retains the original draft and save base.
5. Review and confirm **Save changes**. Validation checks policy structure and references before submission; backend checks remain authoritative. Another concurrent save can require another recovery review. No automatic retry occurs.

A failed response can follow a committed write. Recovery retains the submitted policy and later local edits, including edits that restore an original value. **Discard settings changes** discards local edits only; it cannot undo an unconfirmed write. The unresolved-outcome warning and recovery action remain until saved settings are read and reviewed. A 409 response without a changed revision keeps its save error rather than claiming a revision conflict.

A successful settings response records its saved revision and application status before related data is refreshed. If inventory, audit, or import refresh fails, the error identifies a refresh failure. Use **Reload** instead of repeating the save. Failed or pending application remains visible and requires its existing application workflow. Retained recovery state stays in memory and clears on sign-out or session expiry. Responses from an earlier session cannot replace a later session's drafts.

Access tables search every ID in their policy list, not only the current 20-row page. Counts show matches and pending approvals or revocations. Enter a positive private-user ID or a negative group/channel ID before either list. **Review approval** stages that one ID and opens the settings review. No write occurs before **Save changes**; any other staged policy changes are included in that transaction. Access-list name search uses only cached directory metadata; it is not a remote name lookup. Shared chat-directory name/ID search runs on the server before pagination.

Defaults summarizes saved model, thinking, allowed-model, tool, MCP, and skill defaults. A model draft summary appears only when those model settings differ from saved settings. Its model and thinking controls edit the policy draft directly. Selecting an already globally approved model also adds that exact reference to shared Allowed models if needed; review shows the addition. Explicit chat overrides and global availability do not change. Missing inventory or unsupported thinking remains visible without an automatic model replacement. **Clear shared default model** requires confirmation, then stages only model and thinking as unset; the shared review saves that change. Tool and skill links lead to their editors. Bulk reset is unavailable when all chats already inherit defaults; saving also disables configuration controls. Explicit empty lists deny that category rather than inherit it.

## Audit filters and grouped records

Audit starts with recent records and a closed **Filters** disclosure. Operation and result choices use readable labels mapped to exact API values. **Other exact value** supports historical or unknown values. These choices do not describe the complete audit history. Actor and inclusive UTC date fields are inside Filters. Their accessible names match the visible labels, including **Actor (exact)**, **Operation type**, **Result**, **From date (UTC)**, and **Through date (UTC)**. Custom exact-value inputs have separate names. Active filters remain visible when the disclosure is closed. Expanded fields use two rows on desktop and one column on narrow screens. They apply to all retained records on the server, not just the loaded page. The authenticated `GET /api/audit` endpoint accepts optional `actor`, `operation`, `outcome`, `from`, and `to` query parameters. Text filters contain 1–128 characters. Dates are non-negative integer Unix milliseconds; reversed bounds and duplicate filter parameters are rejected. The response remains an array, ordered by descending record ID, with 100 records per page and the existing bounded `offset` parameter. Unfiltered callers remain compatible. Live inserts can shift offset pages; reload to see the latest records.

Adjacent structured save/application records for the same revision and save target are grouped within the loaded page. Failed applications remain visible in the group summary; expand it for each record and raw data. Groups can continue on adjacent pages, and filters can omit related records. Login events and unrelated save targets stay separate. Historical field-level changes were not recorded; the UI does not invent a change diff. Filtering and pagination do not reload or clear policy drafts. Chat History continues to use the independent unfiltered loaded audit page.

## Skills

**Skills** controls which loaded Pi skills appear in each chat’s model prompt. The inventory contains skill names and descriptions, not file paths or file content. Descriptions are untrusted text, not executable instructions in the WebUI. Maintenance instructions are in the **Installation instructions** dialog. An empty inventory has a direct action to open them.

- Global skill availability limits shared-default and explicit chat selections. **Default chat selection** applies to chats with no skill override. In **Chats → Model & Tools → Enabled skills**, **Inherit default** uses that shared list; an explicit empty list selects no skills. **Reset enabled skills to default** restores inheritance.
- Skill changes use **Review and save changes**, with the same revision, audit, application, and session invalidation flow as other policy edits. Navigation retains drafts. Defaults shows saved and pending effective skill names and links to the Skills editor. **Reset all chats to inherit defaults** also clears skill overrides, including explicit empty lists.
- First registration adds loaded skill names to global and shared-default selections, within the 512-name limits. Existing tool permissions and access approvals do not change. Registration preserves explicit chat overrides. A persistent first-seen registry prevents restart from restoring manually removed selections. Names that exceed capacity are retried on the next startup after space is available.
- Install or update skill files on the host and restart the bot to refresh discovery. Discovery uses the same Pi resource loader as the runtime, including root `skills/` and the bundled URL-reader skills. Names outside the policy’s 1–256-character limit are skipped with a startup diagnostic; other skills and administration startup remain available. The WebUI does not install, edit, or delete skill files.
- A skill that is no longer loaded remains visible when saved or draft selections reference it. It is not added to runtime prompts. Removing global availability retains default and chat selections for review; clear all conflicting selections, including disabled chat overrides, or restore global availability before saving.
- Skill selection controls prompt visibility only. It does not grant tool access, prevent an authorized file tool from reading a skill file, or remove skill content from conversation history. Tool and MCP permissions remain separate. Install only trusted skills.

Existing saved policies load with empty global skill lists and inherited chat skill selections. Startup registration enables loaded skills once to retain the previous default behavior. The database keeps its existing access, models, tools, sessions, and audit history. Before rollback to a version with the previous strict policy schema, restore the matching database backup; that version does not accept skill fields.

## Tool permissions and defaults

**Tool permissions** is the only editor for global and shared-default tool and MCP-server permission lists. The initial columns show Tool/server, Default, and Effective result. **Edit global limits** reveals the Global column. Search matches tool names, source labels, and server names without changing selections. **Tool status** offers All, Not in inventory, and Capability unavailable. The filter combines with search. Missing source metadata is not evidence of missing inventory, and a capability requirement is not a policy denial. Matching groups open during search or filtering; clearing both restores their prior expansion state. Hidden selections remain unchanged. The fixed scope strip counts all pending global and default changes, including filtered names; duplicate tool names count once per scope. Narrow layouts keep inline control labels instead of fixed matrix headings. Pending-policy markers remain compact chips, not full-width grid rows. Effective results apply to inheriting chats only; explicit chat overrides remain separate. Blocked server gates and retained selections appear beside their controls. Tools are grouped by explicit inventory source: Built-in tools, each MCP server, and Unknown source. Each collapsible group shows its tool count and a compact permission list with shared column headings. Expand all and Collapse all control all tool groups. Expansion preferences are stored in this browser for the signed-in administrator. Without a saved preference, the first non-empty group opens. Saved collapsed state is preserved, including Collapse all. New groups remain collapsed when a preference exists. If local storage is unavailable, expansion still works without persistence. Tool names shared by multiple sources appear in each source group and retain the existing shared, name-based permissions. Missing source metadata is shown under Unknown source, without guessing from tool-name prefixes. Collapsing a group does not change permissions or discard drafts. Registration, inheritance, and count rules are under **Permission rules and inheritance**. Manual approval is under **Approve an exact tool name**. The shell/file-tool safety warning stays visible. Defaults shows saved and pending default counts within the global ceiling and links to `section=Tool+permissions#default-tool-permissions`. Per-chat overrides stay in chat details. The old `section=Tools+%2F+MCP` link opens Tool permissions.

- Global permission is a ceiling for every chat. Effective tool and server selections are the inherited or explicit chat list intersected with the global list. `null` inherits that category; an explicit empty list denies it. Default changes do not replace explicit chat overrides.
- Global removal does not delete default or chat selections. The existing backend rejects a policy save while any of those selections exceed the global list, including disabled chat overrides. The workspace shows retained selections and exact explicit-override references. Clear each conflicting selection explicitly or restore the global permission before saving. An unavailable, unselected default cannot be granted; a retained default can still be cleared.
- Counts describe default names within global permission, not working connections or executable MCP tools. MCP execution requires both the server gate and exact tool-name permission. MCP discovery and connection tests record tool names without enabling them. Newly introduced variable, publishing, and image-generation tools also require explicit approval. Existing ordinary built-in registration retains its first-seen enablement within both 512-name limits; a persistent registry prevents restart from restoring manually removed permissions. Existing selected names, explicit chat overrides, and server gates remain unchanged. Automatic built-in registration records an audit event and a revision without cancelling active work; pending/failed application remains blocked. Credential activation and exposure never grant execution permission.
- **MCP servers** manages configuration, enabled state, masked secret replacement, explicit tests, and discovery. Its read-only permission summary identifies saved policy or policy drafts and links to Tool permissions. Viewing or navigating does not test connections or discover tools. Connection saves remain separate from policy saves.
- **Reset all chats to inherit defaults** stages removal of tool, MCP-server, skill, allowed-model, model, and thinking overrides from every policy chat entry, including entries outside the loaded directory page. The confirmation counts entries with an explicit override. Access lists, chat-enabled switches, and shared defaults do not change. Explicit empty selections also become inherited. Use **Review and save changes** to persist the reset.

## Editing scope and status

- **Review and save changes** opens the single policy review. **Save changes** submits all staged policy edits across Chats (including access), Defaults, global capability lists, and custom endpoint configuration. **Review approval** enters this review directly after staging one ID. Neither action writes before final confirmation.
- **Shared defaults** is the shared model/thinking editor. **Save model availability** adds only one selected model globally in a separate confirmation. Provider detail links to the shared or selected-chat editor instead of duplicating model-use controls.
- **Save connection** submits only the named connection and staged secret replacements. Credential actions save authentication separately. These operations are not one atomic transaction.
- The status shows whether saved settings are applied, waiting, or failed. Revision numbers remain under **Revision details**. Pending policy, MCP, and provider drafts have separate notices. Inputs are disabled during an operation to prevent concurrent local edits from being overwritten.
- A foreground operation that fails through the shared workspace handler reveals and focuses its error after the operation ends. Connection drafts and staged secret replacements remain available for retry. Background read failures do not redirect focus. Authentication dialogs keep focus inside the dialog, and session expiry still replaces editors with sign-in. Applied-revision status does not mean that the failed action succeeded.
- Section navigation retains editor drafts. Reload is blocked by policy or unfinished editor input. Audit filtering and pagination are independent read-only queries and retain those drafts. Reload refreshes the current chat page as well as saved settings. Chat pagination and chat retries load only chat metadata and preserve policy and editor drafts. A chat request that returns 401 uses the same session cleanup as other API actions: the sign-in view replaces the editor, and sensitive drafts are cleared. Provider previews, MCP connection drafts, and staged MCP secrets survive a saved-state reload. Use **Reload** after a failed MCP save or deletion to inspect the saved revision and application status without discarding the draft. A failed response can follow a committed change. Browser reload or closing the tab warns about pending edits; sign-out requires confirmation. A browser warning cannot preserve drafts after the tab is closed.
- **Discard custom endpoint draft** resets the endpoint editor to its initial values. For a new endpoint, it clears the editor. It does not change staged policy edits or saved settings.
- Use the explicit discard action only when the pending edits are no longer needed. After a failed policy save, use **Load latest and review draft** to check the saved state; discard does not resolve an unknown outcome or undo a committed write. Inspect application status and use **Retry application** when available.

### Current API limits

- Authenticated `GET /api/chats` retains its array response and ascending ID order, with pages of up to 100 records and at most 1,000 stored chats. Optional `q` searches literal name text or an exact complete numeric ID before pagination. Search text is limited to 128 characters; `%`, `_`, and backslash are literal, not SQL wildcards. Optional canonical `id` performs an exact metadata lookup independently of directory pages; it cannot be combined with search or a nonzero offset. Invalid, duplicate, and unsupported parameters are rejected. Blank search is unfiltered. No directory request queries Telegram or Pi storage. Chats-specific type/access filters remain page-local and draft-aware. Direct ID configuration is a separate expandable form; only an explicit selection changes the URL, and selection does not grant access.
- Access search covers every ID in the selected policy access list, but names are available only for chat pages loaded in this session. Missing names show an explicit fallback. Successful sign-out clears cached chat names and IDs. After sign-in, names come only from pages loaded in the new session. Pending approvals and revocations remain in these searchable, paged lists; undo restores a staged revocation before policy application.
- The persistent status bar shows saved application state and each browser draft scope. With policy edits, it adds one count, one review action, and a discard action. Its measured height sets the workspace scroll offset so focused controls remain below it. The review lists changes across sections. **Discard settings changes** restores the last loaded policy only; provider previews, MCP drafts, and unfinished editor input remain unchanged. Applied-revision status does not mean that browser drafts were saved.
- Search popovers and model, thinking, and advanced-setting dropdowns close when their section becomes inactive, including browser back/forward navigation. Escape returns focus to the trigger; section navigation does not restore focus to a hidden trigger. Provider and Model search keeps focus in the combobox for arrow navigation and Enter selection. Results do not add Tab stops; Tab and Shift+Tab close the picker and continue in the trigger's normal tab order. Provider and model picker buttons include the displayed selection or fallback text in their accessible names. The shared chat selector uses labelled search and ordinary focusable selection buttons, not a custom keyboard overlay. Section editors and chat detail views remain mounted to retain drafts.
- Contextual **Grant access**, **Revoke access**, and **Undo pending revocation** change only the selected ID's explicit private-user or group/channel list. They do not write immediately, approve another scope, enable a disabled override, or authenticate a model. The shared review includes every staged policy edit across sections; **Save changes** confirms them together.
- Access history is read-only. The current API has no environment reconciliation or missing-ID approval workflow. Historical imports never approve IDs or restore revoked access. Access rows edit only the current explicit private-user or group/channel lists.
- Audit activity uses server offset pages of up to 100 records. The server retains at most 10,000 audit records and returns the latest 10 environment access reviews. The filters described above run on the server. There is no exhaustive client-side search.
- MCP inventory returns masked markers, not editable command, URL, or argument values. **Edit fields** starts an empty patch in the guided editor; enter only fields to change. Omitted fields are preserved. The advanced editor shows the same JSON patch. If an MCP draft exists, confirm its discard first. Typing a server name keeps the current JSON draft, including when an intermediate name matches an existing server. Omit `env` or `headers` to preserve that map. A supplied JSON map replaces the whole map: include every key to retain with `null`; omitted keys are removed. An empty map clears all entries. Masked replacements preserve existing keys when JSON omits that map. Connection tests record discovered names without enabling them; explicitly approve exact tool names and the server gate before execution.
- Provider authentication availability is not remote verification. No remote check, authentication interaction, or billable model request starts automatically. Real device enrollment and provider acceptance require separate administrator checks.

## Model providers

The main list contains configured or policy-referenced providers, including saved invalid references during draft edits. **Add provider** searches the catalog; it does not save anything. A provider detail has Connection, Models, and Usage policy references. **Back to providers** keeps the detail draft mounted. Continue editing and review links reveal that detail before moving focus. Switching providers with unfinished endpoint edits requires an explicit discard decision.

Connection owns authentication and custom endpoint configuration. Save endpoint configuration and apply it before authentication. Provider credentials remain in Pi's existing store; the browser never receives existing keys or refresh tokens. Some providers require trusted-host credentials rather than browser API-key/OAuth setup. Provider selection, credential save, and model availability remain separate.

**Check authentication** checks local credential availability only. It does not generate tokens, verify remote entitlement, or run a model. Custom **Discover custom models** checks a bounded model-list endpoint, not generation or model capabilities. Endpoint/protocol draft changes invalidate that result. No check or OAuth flow starts merely by viewing a page.

Models shows the selected provider's global availability while preserving other providers' references. Adding or restoring availability changes no default or chat selection. Removing a model stages its removal from dependent shared/chat allowed lists, clears matching shared model/thinking settings, and resets matching chat model/thinking overrides to inheritance. The impact review shows configured and effective before/after values for affected explicit entries, including disabled and off-page chats. A chat can inherit a different surviving shared model. The full inheriting population and private GitHub outbox impact are not known; the review does not invent those counts. GitHub replies depend on the shared model. Restoring availability does not restore removed selections.

Choose a shared model and supported thinking level in **Shared defaults**. Selecting an available model also stages its shared allowed-list reference when needed; the policy review shows that addition. Chat overrides use the chat editor. Unavailable saved values remain visible without automatic replacements. Unsupported thinking requires a valid choice before saving. Usage counts describe policy references, not running chats.

Custom endpoints support the existing OpenAI Completions, OpenAI Responses, Anthropic Messages, and Google Generative AI protocols. Provider IDs cannot contain slashes; model IDs can. Editable model metadata is configured, not discovered capability. Numeric zero cost placeholders do not establish free usage. Public HTTP(S), DNS, credential/redirect rejection, streamed byte/time limits, and non-routable-target rejection remain enforced; custom transport uses SSE, not WebSocket.

Removing credentials or endpoint configuration requires replacing dependent model references first. Removing a stored credential does not remove ambient credentials or revoke an upstream token. Removing a custom override can restore built-in behavior; no silent model fallback is selected by the editor.

## Runtime secrets and variables

**Secrets & variables** starts with tabs, name search, Add, and Name/Configured state/Updated/Actions rows. Empty inventory, no matches, and failed metadata reads have separate states. Saved secrets are encrypted and write-only: replacement starts blank, Keep unchanged cancels that edit, and deletion has its own confirmation. No fake value is loaded. Variables are public runtime data readable through authorized `read_variable`; they are not a credential store. Writes grant no tool or server access.

Provision the host-only `ENCRYPTION_KEY` before entering credentials. Missing/wrong keys lock secret operations, not administrator login or variable management. Saving and applying a value changes the next operation without restarting the bot; application cancels active model work and replaces old MCP connections. A committed write with failed application remains saved: retry application, not the secret submission. Unknown network outcomes require explicit safe metadata reload before another replacement.

For GitHub CLI authentication, open **Manage GitHub connection** on Secrets, or **Manage GitHub connection** on GitHub mentions, then use **Connect GitHub** in the shared panel. This is one credential store and one active flow, not mentions-only credentials. Configure the deployment-owned OAuth App's public Client ID, consent to `repo`/`read:org`, authorize the device code at GitHub, then explicitly save the verified account. Expiring tokens refresh before authorized shell calls. The encrypted refresh companion is server-owned and is not exposed by generic secret or MCP controls. The existing manual `GH_TOKEN` PAT controls remain available.

A saved account and current application status are separate. Recover lost replies with **Reload GitHub status**; retry only application after a committed failure. Disconnect/reset explicitly removes both credential entries, including orphan/collision data, but does not revoke GitHub authorization. All approved `bash` chats can use or read the token. Connection does not grant access or prove repository entitlement. See [setup, refresh, recovery, and trust limits](runtime-config.md#github-cli-authentication).

Runtime secret storage uses schema v4; GitHub mention policy migration advances the admin database to v5. See [runtime configuration setup, migration, backup, recovery, verification, and deployment handoff](runtime-config.md). Back up the master key separately from state. Same-user tool access is not isolated.

## Retired Service status settings

A database used by the reverted Service status feature can contain a top-level `statusNotifications` policy field under schema v5. The post-revert build rejects that field and can exit during startup skill registration. A longer healthcheck timeout does not correct this data-format mismatch.

On startup, the compatibility fix saves the exact original settings row (policy text, revision, applied revision, status, and authorization epoch) in the private `retired_status_notifications` table before removing only this field from active policy. These operations, audit recording, existing migrations, and strict active-policy validation share one transaction. Any failure rolls back the conversion. All other active values, credentials, authentication records, chat permissions, explicit denials, and retained notification checkpoints/queues remain unchanged. This is an additive archive under schema v5, not a notification subsystem or a relaxed API schema. Other unknown or malformed active fields still stop startup.

The conversion advances revision and authorization epoch, keeps the previous applied revision, and marks settings Pending until normal runtime application succeeds. An older GitHub-recipient conversion can advance them again in the same startup transaction. Reopening converted data does not repeat the conversion. Ordinary settings writes still reject `statusNotifications`; settings/import-report APIs and audit records do not expose archived values. Archive contents remain private database data, not a full backup, and are never restored automatically.

Before deployment, stop the service and retain a protected state backup plus the independent encryption key through the normal backup procedure. Do not delete state volumes or edit the production policy manually to bypass validation. Deploy the corrected build only with operator authorization; verify startup, `/healthz`, applied settings, and retained allow/deny decisions. The preceding post-revert build can read converted active policy and ignores the additional archive table. Do not roll back to a notification-capable build or restore its settings/queues without a separate review: that can resume external delivery. Local fixtures do not establish production recovery.

## GitHub mention authors

Open **GitHub mentions** to manage the GitHub authors who may trigger automatic replies. The status summary uses saved policy, local credential metadata, and application state; author drafts are separate. Prior verified account metadata is not current worker, model, or delivery health. Enter one GitHub username without `@`, select **Add username**, then select **Review and save changes → Save changes**. Names are saved in lowercase and compared without case. Additions and removals remain drafts until saved; **Undo removal** restores a staged removal. An empty saved list disables this channel. The previous `?section=GitHub+notifications` URL opens the renamed page.

The allowlist checks the **author of the mention**, not a Telegram recipient or repository owner. When an allowed author directly mentions the account authenticated by `GH_TOKEN`, Sumire replies on GitHub. Other authors are ignored. Telegram chat access and tool permissions are not required and are not granted by this list.

Use **Manage GH_TOKEN** to configure the shared encrypted secret. The token must permit Notifications API reads and comment writes in the relevant repositories. Configure an authenticated, allowed shared default model before use. Configured state does not prove upstream acceptance.

Edits use normal validation, review, audit, revision/application, and conflict recovery. Concurrent allowlist drafts are not combined automatically. Removing an author blocks pending and future delivery while access is denied; it does not delete existing GitHub comments or transcripts. Chats with `bash` access can independently use the shared token.

Schema v5 clears legacy Telegram recipient IDs instead of interpreting them as GitHub usernames. Review and apply the new GitHub allowlist after migration. No host environment or GitHub Actions configuration is added. See [setup, supported sources, recovery, and trust limits](runtime-config.md#github-mention-replies).

## MCP configuration and secrets

Only the administrator can change MCP commands, endpoints, environment fields, headers, timeouts, and exposure rules. Starting a configured stdio server executes administrator-supplied code. Connection tests can therefore have startup effects even though they do not invoke tools. Stdio connection tests use the bot working directory, including as the base for a relative server `cwd`.

Use **Delete** beside an obsolete MCP entry to remove its configuration and inline credentials, then apply the change. Referenced runtime secrets and variables remain in the shared store; manage them on **Secrets & variables**. First remove that server from global availability, defaults, and explicit chat selections. Deletion checks the saved revision, records an audit event, and frees one of the 16 server slots. A running connection test blocks deletion. Transcript files remain unchanged.

Session creation checks the saved revision before MCP discovery. Each transport start also checks the current authorization epoch, including after asynchronous process-home setup. A revoked chat, server, or configuration cannot start a stale MCP command.

The **MCP servers** page initially shows saved connections with short Add/Edit/Test actions. Configured enabled state is separate from a structured connection observation. Not tested, Checking, Succeeded, Failed, and missing/unknown observations have separate labels; only a current successful observation establishes a published-name count, including zero. Details show the observation time and saved configuration revision. Results are memory-only, are invalidated on apply/configuration change/restart, and do not claim ongoing connection health. A lost response keeps the count Unknown until safe metadata is refreshed; no test is automatically repeated. Opening an editor hides that list until the editor closes. **Add connection** starts a new draft. **Edit fields** opens an empty patch for a saved connection. The editor owns the server name, guided fields, redacted review, and save action. **Close connection editor** retains the draft; **Resume connection draft** reopens it. Replacing a dirty draft requires confirmation. Closing is not discarding. Confirmed **Discard MCP draft** clears the draft and focuses **Add connection** after rendering. Cancelling keeps the draft and current focus. Leaving the section or expiring the session cancels queued editor focus.

New connections show transport-specific fields without replacement selectors. HTTP hides command/argument fields; stdio hides the URL field. Existing connections preserve omitted values and show replacement inputs only when selected. Optional fields are under **Advanced connection fields**. **Replace enabled** selects a patch field; **Enabled after save** sets its value. Secret inputs are under **Secrets (optional)**. Closing any disclosure retains its input. Renaming a connection requires confirmation before secret replacements are cleared.

The guided MCP editor comes before advanced JSON. Both edit the same patch; the API does not return saved command, URL, argument, or secret values. **Edit fields** starts an empty patch and focuses the server name. Select only fields to replace. Advanced JSON supports secret-map operations and per-tool exposure. Invalid or unknown fields remain available in JSON for correction; they are not silently discarded.

**Review field changes** opens the optional preview of set/replaced, added, removed, cleared, and preserved fields. It shows field names, not values. Inventory exposes only configured top-level field names for this preview. The server remains the final validator. A command or URL replacement with omitted `type` clears the stored transport type and infers it again. HTTP selection removes command, arguments, working directory, and environment fields; stdio selection removes URL and headers. Preview these removals before saving. Tests and discovery remain explicit; stdio startup can have side effects.

MCP configuration supports the existing transport fields. An update preserves omitted fields. For `env` and `headers`, null preserves a named value, a literal replaces it, and an empty object clears the map. Use these maps for secrets; do not put secrets in commands, arguments, descriptions, names, or URLs. Ordinary inventory responses show configured markers and field names, not existing secret values.

MCP may depend on private Docker endpoints. Existing MCP HTTP protections remain separate from the public-only custom model provider policy; do not assume MCP endpoints are public-only. Redirects never forward administrator credentials.

## Trust boundary

Tools are capabilities, not an OS sandbox. Pi, shell tools, and stdio MCP processes run with the container user's permissions. A working directory does not confine file access. A shell or file tool can read process-readable state, modify policy or credential files, and reach the network without using another named tool. Administrator-supplied MCP code has the same trust requirement.

Shell tools receive a restricted environment: system and runtime paths, locale fields, the existing Otter skill credential, and the applied managed `GH_TOKEN`. GitHub CLI prompts are disabled. Managed Firecrawl/Morsel secrets and the runtime master key are not injected. They do not directly inherit bot tokens, unused legacy Telegram login secrets, or ambient model provider keys. MCP retains its existing explicit environment policy.

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

Use Node.js 26 or newer from the repository root:

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

Inspector-specific evidence and read-boundary limits are recorded in [Pi Durable Inspector validation](pi-durable-inspector-validation.md).

The browser suite uses API fixtures and a strict-port development server. It includes a Chromium virtual-authenticator registration and sign-in flow. It does not prove real device enrollment, real provider OAuth, or public TLS. For a local authenticated session, use the production build at the default localhost origin. For remote access, use the configured HTTPS origin. Keep Secure cookies and all authentication checks enabled.

Before production acceptance, verify real device registration and passkey sign-in on the configured domain, rejection of unauthorized setup and login, provider authentication with the selected providers, revocation during active work, restart persistence, backup restoration, and HTTPS ingress behavior. Real device and provider tests require the administrator and deployment access; do not substitute fixtures for this evidence.
