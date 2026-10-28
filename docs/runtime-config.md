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

The production image includes `gh`. Use the existing Secrets tab to configure GitHub.com authentication:

1. Configure and back up `ENCRYPTION_KEY` as described above. Deploy the rebuilt image with `docker compose up -d --build sumire` from the repository root.
2. Create a GitHub Personal Access Token with only the required repositories and permissions. Prefer a fine-grained token. Do not submit it through Telegram or include it in commands, URLs, or logs.
3. In **Secrets & variables → Secrets**, select **Add secret**. Set the name to `GH_TOKEN`, enter the token, and select **Save secret**. Do not create a public variable.
4. Wait for **Saved and applied**. The next direct or codemode `bash` execution uses the applied token. Replacement and deletion use the same controls and do not require a bot restart. Pending, failed, locked, or unavailable secret storage does not supply a managed token; a variable named `GH_TOKEN` is not a credential.
5. Approve `bash` only for trusted chats, within both global and chat policy limits. Saving a token does not grant permissions. Every chat with `bash` access can use or read this token; this is not an admin-only GitHub action.
6. The GitHub account owner can explicitly verify the account with the read-only command `gh api user --jq .login`. Automated tests do not contact GitHub, and configured state does not prove token acceptance or repository access.

Sumire resolves the token for each shell call without changing `process.env`. It does not run `gh auth login` or write the token to CLI credential files. `GH_PROMPT_DISABLED=1` disables interactive prompts. Tokens containing a null character are rejected before process creation with a fixed error that does not include the token. Host `GH_TOKEN`, `GITHUB_TOKEN`, and enterprise tokens are not inherited or imported. OAuth/device login and GitHub Enterprise configuration are not included.

Deleting the managed secret stops its injection after application. It does not revoke the token on GitHub, remove manually configured GitHub CLI credentials, erase backups/history, or undo an already started GitHub operation. Revoke obsolete or compromised tokens on GitHub. Do not print tokens with shell commands or `gh auth token`; tool output can remain in conversation history. The deployment administrator must maintain a recoverable database/key backup. Verify production sign-in and ingress log redaction before real token entry.

### GitHub CLI verification and deployment restriction

Checks completed on 2026-10-28:

- Root `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` passed. Unit/integration tests: 2305 across 11 workspaces. The existing unrelated lint warning remains.
- The complete administration browser suite passed: 517 tests, using an isolated local port.
- The production image built successfully. Offline tests under the non-root user verified `gh` token lookup, replacement, and deletion with synthetic credentials. These tests used Docker's default seccomp profile, no network, no host credentials, and no persistent state mounts.

In this validation environment, the repository's configured custom seccomp profile prevents Node from creating a thread (`uv_thread_create`, exit 134). The existing `sumire:local` image fails the same startup check. This change does not alter that profile. The deployment administrator must verify startup under the configured profile before production activation and resolve this failure where it occurs. Do not substitute the test security override for production configuration without a separate review. Live GitHub acceptance, production Passkey sign-in, and master-key backup remain account-owner and deployment-administrator checks.

## Upgrade and import

The administration schema advances from version 3 to 4. The migration retains policies, Passkeys, administrator sessions, imports, and audit history; durable databases are unchanged.

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

For rollback, stop ingress and the bot and restore the old image with its matching pre-upgrade state/bootstrap snapshot. Older binaries reject schema version 4. Review access and revoke administrator sessions before reopening ingress; old backups can restore revoked permissions or keys. Do not delete volumes or automatically replay interrupted Morsel/MCP side effects.

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

## Private GitHub notifications

Use **Secrets & variables** to store `GITHUB_NOTIFICATIONS_TOKEN` as a dedicated secret and
`GITHUB_NOTIFICATIONS_ALLOWED_USER_IDS` as a variable containing a JSON array of unique positive
Telegram user IDs, for example `[123456789]`. Empty or missing lists deny everyone, including
administrators. Enable `read_github_notifications` in global and per-chat tool permissions as well.
Only private chats whose verified chat ID is listed can receive tool results; groups are always denied.
These notifications belong to one configured GitHub account shared by all listed users, not a separate
GitHub account for each Telegram user. Titles and repository metadata are sent to the selected model
and retained in that private chat's durable transcript. Standard long-reply delivery can also
publish content through the configured Morsel service and return a share link; the allowlist is
not a local-only data-processing guarantee.

Use a credential supported by GitHub's Notifications REST API, such as a classic PAT with
`notifications` scope, and verify any organization requirements with the GitHub account owner.
The dedicated credential is never passed to bash and never falls back to GH_TOKEN or host credentials.
The tool reads one bounded page without marking notifications read or modifying subscriptions.
There is no background polling or unsolicited delivery. Replacement/deletion and allowlist edits use
the existing revision/application path; revocation does not erase previously delivered data.

See [the notification package](../packages/github-notifications/README.md) for limits, tests, and
trust boundaries. This feature does not restrict existing GH_TOKEN-based shell access or same-user
filesystem access; those capabilities remain for trusted users only.
