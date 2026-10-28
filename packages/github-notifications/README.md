# GitHub notifications

Private workspace package for bounded, read-only GitHub.com notification metadata. No third-party runtime dependencies. It does not execute `gh`, read environment credentials, mark notifications read, subscribe, poll in the background, or fetch thread bodies.

## Administration WebUI setup

1. In **Secrets & variables → Secrets**, add or replace the shared `GH_TOKEN`: a GitHub.com credential accepted by the Notifications REST API (a classic PAT with `notifications` scope). GitHub CLI uses this same secret. Private repository access remains subject to GitHub permissions and organization requirements. Configured state is not proof of upstream acceptance.
2. Open **GitHub notifications** under **Tools & skills**. Enter a positive Telegram user ID and select **Add recipient** for each recipient. Review and save the changes. Use **Remove** to revoke a recipient; **Undo removal** restores a staged removal. No JSON or generic variable is needed. The list permits at most 1,000 unique positive safe-integer IDs. An empty saved list denies everyone, with no administrator exemption.
3. Enable `read_github_notifications` in global tool availability and in the intended private chats' tool selection, and approve those chats as usual. The tool starts disabled by default. All saved settings must apply successfully.
4. Ask the bot in an allowlisted user's **private chat** to read notifications. Groups are always rejected, even if an allowed user asks there. A single configured GitHub account is shared with every allowlisted recipient; this is not per-user GitHub login.

The authenticated administration UI provides encrypted write-only secrets, revision conflict checks, application, and audit. Recipients are stored in `policy.githubNotifications.allowedUserIds`; old policies default to an empty list. Legacy generic notification entries are ignored, not imported. No new host environment variables or database tables are required. Keep tokens out of variables, prompts, source, and logs. Only the applied managed `GH_TOKEN` is used; there is no host credential or CLI fallback. Chats with `bash` permission can use and read this shared token independently of the recipient list.

## API

`createNotificationClient({ authorize, token, fetch? }).list(query?, signal?)` checks the host-owned authorization callback before credential resolution and after the response. The host must bind it to a trusted recipient and current applied configuration; never accept a model-supplied user ID. `allowsNotificationChat(chatId, allowedUserIds)` checks the structured recipient IDs supplied by the host. The bot validates and persists the list through the shared policy schema, not the generic runtime variable store.

Queries: `all` (false by default), `participating` (false), `page` (1–1000, default 1), `perPage` (1–50, default 20). Each call performs one GET to the fixed GitHub API endpoint, with no redirects, retries, arbitrary URL input, or automatic pagination. Results include `hasMore`; no untrusted Link header is followed. Deadline: 15 seconds including body consumption; response limit: 512 KiB, enforced while reading. Errors never include upstream bodies, credentials, or arbitrary transport messages.

Results contain bounded ID, repository name/private flag, title/type, reason, unread state, update time, and a canonical GitHub issue/PR URL where possible. Other upstream fields are discarded. Titles/metadata are untrusted data, never instructions. No cache is shared between chats.

## Security boundary

The Bot additionally applies normal tool/chat policy to direct and codemode calls. The verified positive private chat ID identifies the Telegram recipient. Revocation blocks subsequent calls and in-flight results once observed; already-delivered content, transcripts, backups, and upstream requests cannot be recalled. Notifications are sent to the configured model and stored in that authorized chat's durable transcript. Existing Telegram delivery rules still apply: long model replies may be published through the configured Morsel service and returned as a share link. This package does not provide local-only processing or control later exports by an authorized user. Only grant the feature where these data transfers are acceptable; authorized users can copy or forward information.

This allowlist is a capability boundary, not an OS sandbox. Same-user shell/file tools and administrator-supplied MCP code may access credential storage or other local transcripts; do not grant unrestricted host capabilities to untrusted users. Existing GH_TOKEN-based bash access can separately reach GitHub and is not governed by this tool's allowlist. Isolate untrusted execution in a separate OS/VM/service if required.

Tests use synthetic credentials and stubbed HTTP responses; no live GitHub request or notification mutation is performed.
