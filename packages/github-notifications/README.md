# GitHub mention replies

Discover direct mentions of the GitHub account authenticated by `GH_TOKEN`. Return only sources authored by an allowlisted GitHub username, then post a generated reply on GitHub. This package does not generate model responses or use Telegram identities.

## Administration setup

1. Save the encrypted **Secret** `GH_TOKEN` in **Secrets & variables** and apply it. The token must support GitHub's Notifications REST API, source reads, and comment writes. A classic PAT needs `notifications` and applicable repository permissions, such as `public_repo` or `repo`. Confirm organization restrictions with the account owner. GitHub CLI uses this same managed secret.
2. In **Defaults → GitHub mentions**, add the **GitHub usernames of mention authors**. Enter names without `@`; review and save the list. Names are normalized to lowercase. The list permits at most 1,000 unique usernames, each 1–39 ASCII letters/digits with single interior hyphens.
3. Configure an authenticated provider and a shared default model allowed globally and in defaults. Wait for successful application.
4. Have an allowed author directly mention the token's account on GitHub. Sumire replies there. Nonallowlisted authors are ignored without starting a model turn. An empty allowlist disables polling and replies. Telegram access and chat tool permissions are unrelated.

The policy field is `githubNotifications.allowedUsernames`. The previous administration URL `?section=GitHub+notifications` opens the renamed page. Admin schema v5 clears the incorrect legacy Telegram `allowedUserIds` lists instead of converting them to GitHub identities. Converted settings become a new pending revision. Missing blocks default empty; current saves reject the old field.

## Supported sources

- Issue and PR bodies.
- Issue and PR comments.
- Submitted PR review bodies.
- Inline PR review comments, including replies within a review thread.

The Notifications API must report reason `mention`. Each source must also contain a direct, case-insensitive `@account` address. Team, assignment, subscription, and review-request notifications do not qualify. Self-authored sources are ignored. The source author, not the repository owner or latest notification activity, determines admission.

Issue/PR bodies, issue comments, and review bodies receive an issue/PR comment. Inline review comments receive a threaded reply. Discussions and commit comments are not supported. The package never marks notifications read, changes subscriptions, or follows upstream pagination URLs.

## API

`createGithubMentionClient({ authorize, token, allowedUsernames, fetch? })` provides:

- `scan({ since?, page?, perPage? }?, signal?)`: resolve the authenticated account, read one notification page, and discover authorized mention sources. The result contains the account, normalized mentions, `hasMore`, and a bounded `pollIntervalSeconds`. Notification pages are 1–1000, with 1–50 items (default 20). Source/comment lists are explicitly paged with a limit of ten pages of 20 items.
- `reply(mention, text, signal?)`: revalidate the current account, source version, author, and admission before posting. Return `sent`, `already-replied`, or `ignored`. Replies must contain 1–60,000 UTF-8 bytes. A deterministic hidden source marker identifies an existing bot-authored reply after an uncertain write.

Issue/PR body keys use the account, repository, source ID, author, and body content. The issue activity timestamp does not change that identity. Marker checks for body replies scan the bounded comment history without an activity-time cutoff. A real body or author change still prevents delivery of an old answer.

A source GET with HTTP 404 or 410 is unavailable. Scans skip that source, and delivery returns `ignored` without a write. Account, marker-list, and POST failures are not treated as missing sources.

The host owns `authorize()`, applied credentials, and the allowlist. It must bind them to trusted application state, not model arguments. Each operation uses one token; credential replacement interrupts it. A persisted mention from another account is never posted under the new account.

All requests use validated paths on `https://api.github.com`, reject redirects, and have a 15-second deadline. Each response is limited to 2 MiB while streaming. One operation is limited to 120 seconds, 200 requests, and 8 MiB total response bytes. Invalid data and exceeded bounds fail closed without returning partial source lists. Errors omit upstream bodies, tokens, private URLs, and raw transport details. No CLI or environment credential fallback is used.

## Bot orchestration and recovery

The bot owns polling, checkpoints, durable generation, and delivery. Its sequential worker polls at least 60 seconds apart, up to the server's one-hour bounded interval. The first enabled poll stores a cutoff two minutes before that poll, before HTTP; retries retain it. Subsequent scans use stored per-account cursors with a two-minute overlap. A pass reads at most ten notification pages of 20 items and retains its cursor if the page cap is reached.

Keep `.telegramagent/github/` on persistent storage. `state.sqlite` records account bindings, cursors, admitted sources, response bodies, and delivery status. Separate per-mention databases under `turns/` keep Pi Durable transcripts. The Harness owns model turns and retries. The worker saves generated text before a GitHub write and retries the same response, with a bot-authored marker check, after an uncertain result.

An ordinary delivery failure retains the saved answer and does not stop later pending items. Retry uses the same answer and marker. Abort, policy, token, author, model, and provider failures still stop the poll. Large comment histories can exceed the existing page bound; delivery then stays pending instead of risking a duplicate.

The channel exposes no shell, file, MCP, or publication tools. Its model receives only the supplied mention context and cannot inspect code or follow links. Applied settings, current author admission, account identity, and model access are checked at work and delivery boundaries; active work is interrupted on settings changes. Source edits prevent posting stale generated text. Already submitted external requests cannot be recalled.

## Trust and deployment

Allowed source bodies and titles are untrusted user data, not system instructions or host authorization. The selected model receives this data, and durable storage retains it. A generated reply is published in the source repository. Removing a username cannot erase posted comments, transcripts, backups, or copies.

The allowlist is not an OS sandbox. Chats with `bash` permission can independently use/read the shared `GH_TOKEN`, and trusted host tools can read local storage. Do not grant host capabilities to untrusted users.

Back up the admin database, encryption key, and GitHub state before deployment. Downgrade only with the matching pre-v5 database backup. No new deployment environment variable or GitHub Actions secret/variable is required.

Tests use synthetic credentials, stubbed HTTP, and a faux model provider. No live GitHub request or comment publication is performed. Before production enablement, the deployment administrator must configure the real token/model and review the allowlist; the GitHub account owner must confirm repository and organization permissions. Live authorization, model charges, and publication remain unverified by local tests.

See [runtime setup and recovery](../../docs/runtime-config.md#github-mention-replies).
