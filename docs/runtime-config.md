# Runtime secrets and variables

The administrator manages service credentials and non-confidential values on **Secrets & variables** in the existing Passkey-authenticated Web UI. The page has **Secrets** and **Variables** tabs. Open it with `?section=Secrets%20%26%20variables` on the configured administration origin.

## Storage and access

- Secrets use AES-256-GCM in `.telegramagent/admin.sqlite`. The encryption key stays in trusted host bootstrap configuration, outside the database.
  - The browser receives names, configured state, update times, and revisions, never saved secret values, hashes, or partial values.
  - A replacement field starts empty. There is no saved-secret reveal, copy, or export action.
- Variables are literal, non-confidential strings. They are displayed in the Web UI.
  - Approved chats with `read_variable` can read every variable in this installation. Returned values can remain in durable conversation history.
  - Values are untrusted data, not instructions or executable configuration. They do not change `process.env`, shell configuration, or bot runtime limits.
- Names use uppercase ASCII letters, digits, and underscores, start with a letter, and have at most 128 characters. Names must not contain sensitive values.
- The installation supports at most 256 entries and 8 KiB of UTF-8 per value. Empty variables are valid; empty secrets are not. Values retain whitespace and are not expanded.
- Names are unique across kinds. To convert a secret into a public variable, delete the secret and explicitly create a variable after reviewing the disclosure warning.
- `BOT_TOKEN`, `BOT_ADMIN_ID`, `LOGFIRE_TOKEN`, `ADMIN_*`, and `ENCRYPTION_KEY` remain host bootstrap settings. Model-provider authentication stays in Pi's existing credential store.

The package is [`@narumitw/sumire-runtime-config`](../packages/runtime-config/README.md). The bot owns authorization, audit, transactions, and application. The frontend does not import the Node-only store.

## Configure the encryption key

Do this on the trusted deployment host, before entering real service credentials. Do not send keys through Telegram or paste them into an issue, pull request, or agent conversation.

Generate a 32-byte key in a private host file. This command refuses to overwrite an existing key and does not print it:

```sh
install -d -m 700 "$HOME/.config/sumire"
(umask 077; set -C; key=$(openssl rand -hex 32) && printf '%s' "$key" > "$HOME/.config/sumire/runtime-key")
```

Use trusted deployment tooling to configure that file's exact content as `ENCRYPTION_KEY` in the ignored root `.env` or equivalent bootstrap environment. Keep `.env` private. Do not add the file or value to Git, the database, a browser variable, or `instructions/`. The supplied Compose service already loads root `.env`; no public endpoint or additional port is required.

Restart through the repository-root Compose workflow:

```sh
docker compose up -d --build sumire
```

Use `openssl rand -hex 32` to generate 64 hex characters representing exactly 32 bytes. Existing canonical Base64 keys remain supported, so an environment-variable rename does not require changing the key bytes or ciphertext. Every existing encrypted entry is authenticated before secret writes or import are allowed. A missing/invalid key shows **unavailable**; a valid-format key that cannot authenticate existing ciphertext shows **locked**. Authentication failure does not overwrite ciphertext or create mixed-key data.

Administrator login and variable management remain available while secrets are unavailable/locked. Secret consumers and mutations fail closed. Repair the key through trusted host configuration and restart. Do not change the master key independently of its ciphertext. In-place master-key rotation is not included in this release.

## Rename an existing bootstrap setting

If a deployment already uses `SUMIRE_SECRETS_KEY`, rename it to `ENCRYPTION_KEY` and keep its existing value. The old environment-variable name is no longer read. Existing canonical Base64 values remain valid under `ENCRYPTION_KEY`; no database migration or re-encryption is needed. Do not generate a new key for an existing encrypted database. Restore the matching key if the store becomes locked. If a stored entry already uses the newly reserved name, it remains visible and can be deleted explicitly; creation and replacement under that name are blocked.

## Add or change a value

1. Sign in with the configured administrator's Passkey and open **Secrets & variables**.
2. Save or discard policy, MCP, provider, and other editor drafts first. Runtime-value changes have their own save boundary and revision.
3. Select a tab and use **Add secret**, **Add variable**, **Replace**, or **Edit**. Enter the exact name and value, then select the explicit save action.
4. Check application status. A successful write can be **Saved and applied**, saved/pending, or **Saved; application failed**.
   - After successful application, the next operation uses the current stored value without restarting the bot.
   - Application aborts active model work and closes old session-owned MCP connections. Conversation and reply-tree records remain.
   - New secret-consuming requests are blocked while application is pending or failed. Use the existing application retry; do not submit a saved secret again.
   - Already started operations can complete. Replacing a key does not revoke it at the provider or roll back a publication.
5. For deletion, remove every saved MCP reference first, including references in disabled entries. Confirm **Delete and apply**. Built-in Morsel/Firecrawl consumers become unavailable when their key is deleted.

A stale revision returns a conflict. A lost response can follow a committed write. Neither condition triggers automatic resubmission. Use **Reload safe metadata**, discard the current draft when prompted, and explicitly decide whether another replacement is needed. Secret values are not returned for comparison. A failed related-data refresh is not evidence that persistence failed.

Secret drafts exist only in component memory. Successful persistence, Cancel, confirmed navigation/tab changes, sign-out, and session expiry clear them. Drafts are not placed in browser storage, URLs, the shared policy draft, or review JSON. Request-body logging must remain disabled at ingress.

## Bot and MCP consumers

- `MORSEL_API_KEY` is resolved at each publication for the Pi publishing tool, `/f`, and normal Telegram delivery. The key is not retained in startup Settings.
- `FIRECRAWL_API_KEY` is snapshotted for each Pi URL-tool or Telegram article load. The bot explicitly supplies a key or null; a missing managed key never restores an environment key.
  - Firecrawl can send the target URL, including its query, to an external service and incur charges. Storing a key is not approval to use a tool.
  - The standalone URL-reader packages retain environment discovery when their optional host credential option is omitted. Explicit null disables it.
- MCP uses `${NAME}` only in explicitly configured `env` and `headers` fields. Open **Stored references (recommended)** and select **Stage stored reference** in the connection editor to stage a reference without copying a decrypted value.
  - For Firecrawl, configure the Authorization header as `Bearer ${FIRECRAWL_API_KEY}`.
  - Each server receives only its explicit bindings. The bot does not resolve them from the complete host environment or inject unrelated secrets.
  - Structurally valid unresolved references remain saved. The connection stays unavailable until the referenced value exists and configuration is applied. Placeholders are never sent literally.
  - Existing MCP field, credential-byte, transport, redaction, and exposure limits still apply. A stored 8 KiB value can exceed MCP's stricter 4 KiB per-credential bound and make that connection unavailable.
  - A running administrator connection test blocks runtime-value writes. Apply saved settings before starting a new test.
- `read_variable({ name })` returns a literal value or `{ found: false }`. Secret names behave like missing variables. This tool and newly introduced publishing capability names start denied until explicitly approved in Tool permissions.
- Native shell tools receive only the applied `GH_TOKEN` from the managed secret store, in addition to existing runtime paths and the Otter credential. They do not receive managed Firecrawl/Morsel keys or the master key.

Credential saves and MCP discovery never grant chat, tool, skill, server, or model permissions. Newly discovered MCP tools require explicit approval; existing saved approvals remain unchanged. Local configured/available status does not prove that a provider accepts the key. No remote verification, model request, or publication starts automatically.

Each service operation retains its own credential for response/error redaction, including after replacement or deletion. Public errors do not retain credential-bearing upstream causes. Exact-value redaction does not guarantee removal of encoded/transformed values.

## GitHub CLI authentication

The production image includes `gh`. The Secrets tab supports **Connect GitHub** through Device Flow and the existing manual PAT controls.

### Connect with a GitHub OAuth App

1. Configure and separately back up `ENCRYPTION_KEY` as described above. Before deployment, verify the production startup restriction below.
2. The deployment administrator registers a dedicated [GitHub OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) and enables **Device Flow**. Keep the default token-expiration setting. Registration can require account-owner access and MFA. Use only public, non-secret registration metadata. Device Flow does not use a callback handler or client secret.
3. Open **Secrets & variables → Secrets → Configure GitHub Client ID**. Enter the app's public Client ID, then select **Save GitHub Client ID**. It is saved as the non-confidential runtime variable `GITHUB_OAUTH_CLIENT_ID`; no environment or GitHub Actions variable is required. Wait for successful application.
4. Select **Connect GitHub** and review the fixed `repo` and `read:org` scopes. `repo` includes public/private repository read/write and some organization resources. OAuth cannot restrict access to one selected repository. Explicitly confirm replacement if `GH_TOKEN` is already configured.
5. Select **Start GitHub authorization**, open the displayed GitHub device link, and enter the temporary user code. Only authorize a code from your own current interaction. No credential is saved yet.
6. Check the verified account and actual granted scopes, then select **Save and apply this account**. Account verification contacts GitHub; it does not prove access to every repository. Successful application makes the token available to the next authorized direct or codemode `bash` call without restart.

A changed settings revision invalidates an unfinished login. Cancellation, logout, session expiry, and server shutdown stop the local interaction. Pending authorizations do not resume after restart. Device codes expire within 15 minutes; only the initiating administrator session can inspect or cancel a flow.

If a response is lost, use **Reload GitHub status**. Completed receipts retain their saved revision for five minutes, within a 16-state bound. A later settings revision is shown separately. **Saved; application failed** requires only **Retry application**, not another login or save. An evicted receipt or restarted server can leave the historical outcome unknown; inspect current safe metadata before another action. Page loads and local status checks never start a new GitHub authorization.

### Expiry, refresh, and reset

The access token remains encrypted as `GH_TOKEN`. Its server-owned companion, `GITHUB_OAUTH_STATE`, stores encrypted refresh credentials and account/expiry metadata. This entry is not available through generic secret controls, variable reads, MCP bindings, or browser responses. No schema migration is needed. The existing 256-entry and 8 KiB-per-value bounds apply; a new OAuth connection needs two credential entries.

An authorized shell call refreshes an expiring token when less than 60 seconds remain. Refresh uses the app that issued the stored token. Editing the Client ID changes later authorizations, not the existing grant. Concurrent callers share one refresh. An encrypted attempt marker is committed before exchange; success rotates the access/refresh pair atomically. Rotation does not advance the policy revision, call global application, or abort the requesting model turn. Current application and tool authorization are checked again before dispatch.

An unresolved attempt after restart, uncertain exchange/persistence, expired refresh token, or invalid stored pair requires **Reconnect GitHub**. No exchange is automatically repeated after an uncertain outcome. Malformed/orphaned companion state or a digest mismatch fails closed; it is not treated as a manual PAT. A late refresh cannot restore a manually replaced/deleted credential or invalidate a newer connection.

Use **Disconnect GitHub** or **Reset GitHub connection** to explicitly remove `GH_TOKEN` and `GITHUB_OAUTH_STATE`, including orphan/collision data. Review the named entries before confirming; reset can remove an existing entry with the reserved companion name. Saved MCP references must be removed first. Ordinary manual `GH_TOKEN` replacement/deletion clears a valid companion atomically, even when the replacement value is unchanged. Invalid/colliding state requires explicit reset instead.

Lazy refresh updates native shell credentials only. It does not update credentials copied into an existing MCP transport. Use a separate credential for such connections.

### Manual PAT and trust limits

For fine-grained repository restrictions, create a GitHub PAT and use **Add secret → GH_TOKEN → Save secret**. Do not use a public variable. Manual PATs and non-expiring OAuth tokens do not trigger refresh. A public variable named `GH_TOKEN` is not a credential. Without `GITHUB_OAUTH_STATE`, it does not block shell execution and is never injected into the shell environment. Reset that kind collision before connecting GitHub. A companion entry still requires a valid managed pair; malformed or orphaned state fails closed.

Approve `bash` only for trusted chats, within global and chat policy limits. Every chat with `bash` access can use or read the effective token. Connection does not grant permissions and is not an admin-only GitHub action. The account owner must explicitly verify intended repository access, including organization/SSO approval where required; `gh api user --jq .login` is a read-only account check. Never send credentials through Telegram or include them in commands, URLs, or logs.

Sumire resolves the token for each shell call without changing `process.env`. It does not run `gh auth login` or write the token to CLI credential files. `GH_PROMPT_DISABLED=1` disables interactive prompts. Tokens containing a null character are rejected before process creation with a fixed error that does not include the token. Host `GH_TOKEN`, `GITHUB_TOKEN`, and enterprise tokens are not inherited or imported. GitHub Enterprise, multiple accounts, Git credential-helper setup, and SSH-key provisioning are not included.

Disconnecting or deleting the managed credential stops its injection after application. It does not revoke the token on GitHub, remove manually configured GitHub CLI credentials, erase backups/history, or undo an already started GitHub operation. Revoke obsolete or compromised tokens on GitHub. Do not print tokens with shell commands or `gh auth token`; tool output can remain in conversation history. The deployment administrator must maintain a recoverable database/key backup. Verify production sign-in and ingress log redaction before real token entry.

Before rolling back to token-only code, disconnect the managed OAuth connection or replace it with a PAT and apply the change. Confirm that the companion entry is removed. Older code cannot refresh an expiring token. Preserve state volumes and the matching key; never replay interrupted GitHub writes.

### GitHub CLI verification and deployment restriction

Checks completed on 2026-10-29:

- Root `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` passed. Unit/integration tests: 2,619 across 11 workspaces. The existing unrelated lint warning remains.
- The complete administration browser suite passed: 545 tests, using an isolated local port. The 42 focused GitHub/runtime-secret browser tests also passed.
- The production image built successfully. Offline tests under the non-root user verified Device Flow, account confirmation, encrypted save, single-flight refresh, `gh` authentication, and disconnect with synthetic credentials. These tests used Docker's default seccomp profile, no network, no host credentials, and no persistent state mounts.
- Independent review found and fixed post-body session revocation, pre-spawn authorization races after filesystem checks, and premature receipt eviction during application. Controlled tests also verify that adapter/status-read failures after commit preserve the saved outcome without repeating persistence. Final independent review found no implementation blocker.

In this validation environment, the repository's configured custom seccomp profile prevents Node from creating a thread (`uv_thread_create`, exit 134). The existing `sumire:local` image fails the same startup check. This change does not alter that profile. The deployment administrator must verify startup under the configured profile before production activation and resolve this failure where it occurs. Do not substitute the test security override for production configuration without a separate review. Live GitHub acceptance, production Passkey sign-in, and master-key backup remain account-owner and deployment-administrator checks.

Production handoff remains external to automated verification:

- **OAuth App owner:** register the dedicated app, enable Device Flow, retain token expiration, and provide its public Client ID through the WebUI. Registration/MFA and real authorization were not performed by the implementation agent.
- **GitHub account/organization owner:** approve the displayed scopes and verify the identity plus an intended repository, including organization/SSO restrictions. Do not enable production use until this live verification succeeds. Synthetic tests do not establish repository entitlement.
- **Deployment administrator:** maintain separately protected matching database/key backups, verify real Passkey sign-in and ingress body-log exclusion, and verify Node startup under the intended production security profile. Resolve the reproduced profile failure where it occurs; the isolated test override is not a production configuration change.

## Upgrade and import

Runtime secret storage was added in schema v4, preserving existing policies, Passkeys, administrator sessions, imports, and audit history. The current administration schema is v5; the [GitHub mention migration](#migration-and-trust-limits) clears legacy Telegram recipient lists. Existing Telegram durable databases are unchanged.

1. Stop the bot and prepare the backups described below before upgrade.
2. Configure and separately back up `ENCRYPTION_KEY`.
3. Start the upgraded image with the existing state volume.
   - Before MCP import and consumer creation, the first unlocked startup imports nonempty legacy `FIRECRAWL_API_KEY` and `MORSEL_API_KEY` values only when their names are absent.
   - Existing entries of either kind win. No other environment values are scanned or imported.
   - An atomic import marker and counts prevent overwrite on restart and prevent deletion from restoring a legacy environment value. Even a zero-entry unlocked import records its marker.
   - Missing, invalid, or mismatched keys defer import and its marker. Variables created while locked do not prevent later import of absent service-key names.
4. Review **Audit → Import reports**, stored entries, capability permissions, and applied status.
5. Add values for other existing MCP references explicitly. Entries skipped by an older completed MCP import are not automatically resurrected; recreate the intended connection through the Web UI.
6. After explicit live verification by the service account owner, remove legacy service keys from deployment environment settings. They are not runtime fallback sources after upgrade. Revoke obsolete keys at the service when appropriate.

Import source MCP files remain administrator-owned and read-only. Inline MCP credentials remain compatible and masked, but are not automatically moved into the encrypted store. Replace them with stored references manually. This feature does not encrypt the complete database or Pi credential files.

## Backup, recovery, and rollback

- Back up a stopped service or use a consistent SQLite backup. Include durable state and provider credentials according to the administration guide.
- Keep the master key and bootstrap configuration under restricted access, separately from state backup bundles. A stolen database alone must not include the decryption key.
- Retain a matched database/key pair and image reference. Test restore with temporary copies before production activation.
- If the key is wrong or unavailable, keep the store locked and restore the matching key. Never repair this by deleting the complete administration database, bypassing authentication, or restoring environment fallback.
- Deletion does not erase backups or old conversation history. A compromised service key must be revoked upstream.

If no matching key backup exists, obtain replacement credentials from the service owners. Only a trusted host operator can perform this stopped-service reset of encrypted entries after a consistent backup:

```sql
BEGIN IMMEDIATE;
DELETE FROM runtime_config WHERE kind='secret';
UPDATE settings SET revision=revision+1,epoch=epoch+1,status='pending' WHERE id=1;
INSERT INTO audit(actor,time,operation,revision,outcome,target)
SELECT 'host-recovery',CAST(strftime('%s','now') AS INTEGER)*1000,
       'runtime-config.reset',revision,'reset','runtime-config' FROM settings WHERE id=1;
COMMIT;
```

Retain variables, policies, Passkeys, administrator sessions, audit history, import markers, and transcripts. Provision a new master key through trusted host configuration, restart, and enter replacement service credentials in the authenticated UI. This discards every encrypted runtime secret, including any other service keys, and must not run against a live database. There is no HTTP reset endpoint. Retaining the import marker prevents legacy credentials from returning.

For rollback, stop ingress and the bot and restore the old image with its matching pre-upgrade state/bootstrap snapshot. Older binaries reject databases newer than their supported schema. Review access and revoke administrator sessions before reopening ingress; old backups can restore revoked permissions or keys. Do not delete volumes or automatically replay interrupted Morsel/MCP side effects.

## Verification and deployment handoff

Automated verification uses synthetic keys, temporary databases, local MCP fixtures, fake HTTP responses, and Chromium virtual authenticators. It does not contact real providers or authorize billable requests. Required checks are the root formatting/lint/typecheck/test/build commands, the complete administration browser suite, and `docker build --target runtime-application .` with its offline startup-import check.

Verified on 2026-10-28:

| Check | Result |
| --- | --- |
| Root `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` | Passed; 2,301 unit/integration tests across 11 workspaces. |
| `npm run test:browser --workspace @narumitw/sumire-admin -- --workers=4` | Passed; 516 tests, including CRUD/failure/lifecycle cases and all ten pages in shared geometry checks. |
| `docker build --target runtime-application .` | Passed; production startup import runs with networking disabled. |
| Independent diff/security review | Credential-triggered MCP grants, JSON-escaped Morsel key echoes, and the 513-tool discovery boundary were fixed and have regression tests. No remaining implementation blocker was identified. |

The root lint command retains one pre-existing `innerText` performance warning in an unrelated Durable visual test. Production `npm audit --omit=dev` still reports one high and one moderate finding in the existing Undici/Pi dependency chain. A baseline audit with all `origin/main` workspace manifests confirms identical findings; this feature adds no third-party runtime dependency. Those dependency advisories remain unresolved and are not described as a passed security audit.

The bootstrap-key follow-up also verifies hex/Base64 startup selection, malformed key rejection, same-key Base64/hex reopening without ciphertext changes, and explicit cleanup of legacy entries whose names became reserved.

Full-suite testing also found and fixed a fixture-only UTF-8 issue: local model HTTP requests now buffer bytes before decoding, so split multibyte prompts remain intact. Browser tests run separately from workspace builds to avoid development-server reloads from linked dependency outputs. Failed intermediate runs were corrected and the complete checks above were rerun successfully.

Production verification remains with these roles:

- **Deployment administrator:** provision and separately back up the key after implementation is deployed; verify matched state/key restart and restoration. Production activation requires a recoverable matched backup.
- **Service account owner:** enter real credentials and explicitly approve live Firecrawl/Morsel tests, charges, and publication content. Automated fixtures do not verify upstream acceptance. Remove legacy environment values only after the stored path works; revoke replaced service keys separately.
- **Deployment administrator:** verify real Passkey sign-in, HTTPS origin/ingress, private backend binding, and exclusion of request bodies from logs. Virtual authenticators do not verify the physical device or production domain.

## Trust boundary

This is not an OS sandbox. Authorized shell/file tools and administrator-supplied stdio MCP code run with the bot user's permissions and can access same-user state, processes, and networking. Encryption, environment filtering, and tool permissions do not isolate the key/database from such code. Do not enable unrestricted tools for untrusted chats. Use a separate tested OS/VM boundary when that isolation is required.

## GitHub mention replies

The allowlist identifies **authors on GitHub**, not Telegram recipients. If an allowed author directly mentions the account authenticated by `GH_TOKEN`, Sumire generates a reply and posts it on GitHub. Other authors are ignored without a model turn or reply.

### Setup

1. In **Secrets & variables → Secrets**, save the shared GitHub.com token as `GH_TOKEN`. Use a token accepted by the Notifications REST API, such as a classic PAT with `notifications` and the repository permissions needed to read sources and write comments (`public_repo` for public repositories or `repo` for private repositories). Confirm organization requirements and the account's repository access.
2. Under **Defaults → GitHub mentions**, enter each allowed author's **GitHub username**, without `@`, and select **Add username**. Select **Review and save changes → Save changes**.
3. Configure an authenticated provider and an allowed shared default model and thinking level. Both global and default model selections must permit that model.
4. Wait for **Settings saved and applied**. Have an allowed author mention the token account in a GitHub issue, PR, comment, or review. The reply appears on GitHub, not Telegram. Telegram chat access and tool permissions do not control this channel.
5. To stop automatic replies, remove the relevant usernames, review, and save. An empty saved allowlist disables polling and replies.

Usernames contain 1–39 ASCII letters/digits with single interior hyphens. Names are stored in lowercase; duplicates are rejected after case normalization. The limit is 1,000 names in `policy.githubNotifications.allowedUsernames`. The previous `?section=GitHub+notifications` link opens the renamed page.

### Processing and recovery

- The sequential worker polls at least 60 seconds apart and honors longer GitHub polling intervals, up to one hour. It reads notification reason `mention` and checks each source's author and direct `@account` address. Repository ownership and the latest comment author do not authorize an earlier source.
- Supported sources are issue/PR bodies, issue/PR comments, submitted PR reviews, and inline review comments. Inline comments receive a reply in their review thread; other sources receive an issue/PR comment. Discussions, commit comments, team mentions, assignments, subscriptions, and review requests do not trigger replies.
- An enabled poll resolves the managed GitHub credential before reading notifications. Expiring OAuth credentials use the existing refresh process without Telegram shell activity. Applied settings and the author allowlist are checked before refresh and again before polling. An empty allowlist causes no refresh request.
- The first enabled poll stores a cutoff two minutes before that scan, before any notification request. Retries preserve this cutoff; older historical mentions are not replayed. Later scans use persisted per-account checkpoints with a two-minute overlap. Downtime can delay replies.
- The worker scans at most ten notification pages of 20 items per pass. After each complete page, it saves the page number, a hash of that page, and the original scan cutoff. Later polls recheck that account's last complete page before they continue. A changed page restarts the scan at page 1. This avoids skipped entries when notification offsets move. Progress survives a page limit, failure, restart, or same-account token rotation. Only a complete scan advances the checkpoint. Activity during a continued scan remains in the next scan's time window.
  - Notification page numbers remain limited to 1–1000. Source lists have at most ten pages of 20 items each. A source list that exceeds its bound fails without returning partial data. Backlogs above these limits need administrator investigation.
- Notifications are not marked read, subscriptions are not changed, and upstream pagination URLs are never followed. Each request uses a fixed validated GitHub API destination, a 15-second deadline, and a streamed 2 MiB response limit. Each scan/reply operation has a 120-second deadline, a 200-request limit, and an 8 MiB aggregate response limit.
- The worker stores account identity, checkpoints, scan continuations, admitted mentions, and generated replies in `.telegramagent/github/state.sqlite`. Each mention has separate Pi Durable storage under `.telegramagent/github/turns/`. Keep this directory with the application's persistent state.
- Pi Durable owns generation, retries, and transcript persistence. The channel uses no shell, file, MCP, or publication tools. The model receives the allowed mention's title, body, author, repository, and URL; it cannot inspect code or follow links.
- Generated replies are saved before delivery. A hidden source marker permits duplicate checks after restart or an uncertain POST result. Issue/PR body identity uses body content, not the issue activity timestamp. Marker checks for body replies scan the bounded comment history without an activity-time cutoff. A body or author change prevents delivery of an old answer.
- A source GET with HTTP 404 or 410 is skipped without a reply. Other delivery failures retain the saved answer for retry and do not stop later pending items. Access changes and cancellation still stop the poll.
- Applied policy, author access, credential changes, model access, and authenticated bot identity are checked before work and delivery. Account changes cannot redirect pending replies. Removed authors remain blocked; already submitted requests and posted comments cannot be recalled.

### Migration and trust limits

Admin database schema v5 replaces the incorrect Telegram-recipient policy. Valid legacy `allowedUserIds` lists become **empty** GitHub allowlists, never usernames. Converted settings receive a new pending revision and must apply before use. Missing blocks default empty. Current save requests reject the legacy field; malformed legacy state stops migration. Restore a matching database backup and encryption key before downgrading to v4.

Only the applied encrypted `GH_TOKEN` is used. There is no host environment or GitHub CLI credential fallback. Chats with `bash` access can independently read or use this shared token; this allowlist is not a host sandbox.

Allowed mention data is sent to the selected model and retained in dedicated durable transcripts. Replies are published in the source repository. Removing a username does not erase transcripts, backups, or posted replies. Approve only authors and repositories for which these transfers are acceptable.

### Verification and deployment handoff

Local verification uses synthetic credentials, stubbed HTTP, a faux model provider, and browser fixtures. It covers author admission, source/account checks, revocation, cursor/delivery recovery, bounds, schema migration, and administration edits. No live GitHub request, model charge, comment publication, credential change, or deployment is part of those checks.

The deployment administrator must configure the real token and shared model, review the allowlist, and confirm GitHub permissions before enabling this worker in production. Account owners must verify organization requirements. These live behaviors remain unverified. No new host environment variable or GitHub Actions secret/variable is required.

See [the GitHub mention package](../packages/github-notifications/README.md) for the API and limits.
