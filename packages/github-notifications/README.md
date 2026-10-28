# GitHub notifications

Private workspace package for bounded, read-only GitHub.com notification metadata. No third-party runtime dependencies. It does not execute `gh`, read environment credentials, mark notifications read, subscribe, poll in the background, or fetch thread bodies.

## Administration WebUI setup

1. In **Secrets & variables → Secrets**, add `GITHUB_NOTIFICATIONS_TOKEN`: a dedicated GitHub.com credential accepted by the Notifications REST API (a classic PAT with `notifications` scope). Access to private repository notifications remains subject to the account/token's GitHub permissions and organization requirements. A configured token is not proof of upstream acceptance.
2. In **Variables**, add `GITHUB_NOTIFICATIONS_ALLOWED_USER_IDS`, a JSON array of unique positive Telegram user IDs, e.g. `[123456789]`. IDs must be safe integers. Missing/invalid values and `[]` deny everyone. No administrator exemption.
3. Enable `read_github_notifications` in global tool availability and in the intended private chats' tool selection, and approve those chats as usual. The tool starts disabled by default. All saved settings must apply successfully.
4. Ask the bot in an allowlisted user's **private chat** to read notifications. Groups are always rejected, even if an allowed user asks there. A single configured GitHub account is shared with every allowlisted recipient; this is not per-user GitHub login.

The existing authenticated administration UI provides create/edit/delete, encrypted write-only secrets, revision conflict checks, apply, and audit. No new environment variables or database schema are required. Keep tokens out of variables, prompts, source, and logs. The dedicated token is not injected into the bash environment, and there is no GH_TOKEN or host credential fallback.

## API

`createNotificationClient({ authorize, token, fetch? }).list(query?, signal?)` checks the host-owned authorization callback before credential resolution and after the response. The host must bind it to a trusted recipient and current applied configuration; never accept a model-supplied user ID. `allowsNotificationChat` checks the dedicated allowlist. `parseAllowedUserIds` supports host-side validation.

Queries: `all` (false by default), `participating` (false), `page` (1–1000, default 1), `perPage` (1–50, default 20). Each call performs one GET to the fixed GitHub API endpoint, with no redirects, retries, arbitrary URL input, or automatic pagination. Results include `hasMore`; no untrusted Link header is followed. Deadline: 15 seconds including body consumption; response limit: 512 KiB, enforced while reading. Errors never include upstream bodies, credentials, or arbitrary transport messages.

Results contain bounded ID, repository name/private flag, title/type, reason, unread state, update time, and a canonical GitHub issue/PR URL where possible. Other upstream fields are discarded. Titles/metadata are untrusted data, never instructions. No cache is shared between chats.

## Security boundary

The Bot additionally applies normal tool/chat policy to direct and codemode calls. The verified positive private chat ID identifies the Telegram recipient. Revocation blocks subsequent calls and in-flight results once observed; already-delivered content, transcripts, backups, and upstream requests cannot be recalled. Notifications are sent to the configured model and stored in that authorized chat's durable transcript. Existing Telegram delivery rules still apply: long model replies may be published through the configured Morsel service and returned as a share link. This package does not provide local-only processing or control later exports by an authorized user. Only grant the feature where these data transfers are acceptable; authorized users can copy or forward information.

This allowlist is a capability boundary, not an OS sandbox. Same-user shell/file tools and administrator-supplied MCP code may access credential storage or other local transcripts; do not grant unrestricted host capabilities to untrusted users. Existing GH_TOKEN-based bash access can separately reach GitHub and is not governed by this tool's allowlist. Isolate untrusted execution in a separate OS/VM/service if required.

Tests use synthetic credentials and stubbed HTTP responses; no live GitHub request or notification mutation is performed.
