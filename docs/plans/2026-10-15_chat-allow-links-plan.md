# Stage 1: Telegram chat approval links

## Goal

Add `/allow` so a user can request access for the current Telegram chat. A signed-in administrator reviews the request in the WebUI and confirms approval. Keep `BOT_WHITELIST` during this stage and preserve existing permissions in SQLite before its removal.

Implementation and automated verification are complete on `narumi/feat/chat-allow-links`. Production acceptance remains blocked on administrator deployment and real-device checks. Stage 2 is specified separately in `2026-10-15_remove-bot-whitelist-plan.md` and must not start yet.

## Context

- `apps/bot/src/admin/store.ts` already owns `.telegramagent/admin.sqlite`, policy revisions, audit records, chat metadata, and administrator sessions. Use this SQLite database; do not add PostgreSQL or a second authorization store.
- `initialPolicy` in `apps/bot/src/admin/policy.ts` imports positive environment IDs into `privateUsers` and negative IDs into `groups`. The store inserts this policy only when settings do not exist. Restart does not merge later environment changes.
- `apps/bot/src/telegram/bot.ts` handles `/admin` before its authorization middleware. `/allow` needs a similarly narrow exception, without access to model turns, attachments, tools, or passive context.
- Existing policies require both list membership and the absence of an explicit disabled chat override. Approval must account for both.
- WebUI authentication remains the existing single-administrator Passkey flow. A request link does not create an account, enroll a Passkey, or grant approval authority.

## Architecture

### Request and approval

- Accept `/allow` in private chats, groups, and supergroups. Support `/allow@botname` through the Telegram command handler. Reject arguments rather than accepting a supplied chat ID. Channel posts remain outside this command flow; administrators can manage channel IDs in the WebUI.
- Read the ID, type, and display name from Telegram's current chat. In private chats, require the sender ID to match the chat ID. Treat names as untrusted display data.
- Return a link only when administration and its store are available. Otherwise give setup guidance without changing legacy authorization. Do not send links for ordinary denied messages.
- Generate 32 random bytes encoded as hex. Store only the SHA-256 hash, bound chat metadata, configured origin, creation time, and expiry. Expire requests after 15 minutes; a replacement invalidates the previous pending request for that chat.
- Bound issuance with a per-chat one-minute cooldown and a maximum of 1,000 unexpired requests. Remove expired rows before checking capacity. Do not create unbounded per-sender state. If the chat is already effectively approved, return status without issuing a token.
- Put the token in a URL fragment. Capture it before network calls and remove it with `history.replaceState`; do not put it in query strings, analytics, logs, audit values, or referrers. Use a separate fragment field from initial Passkey setup.
- Preserve the pending approval intent through Passkey sign-in and page reload using only browser-tab session storage. Clear it after success, expiry, invalidation, or logout. Store no administrator session credentials there.
- For HTTPS, return an inline URL button. For the default localhost origin, return a copyable URL and explain that it must open in a browser on the Sumire host. Disable Telegram link previews. Remote use needs a configured HTTPS `ADMIN_ORIGIN` and a Passkey for that domain.
- Require an authenticated administrator before resolving request metadata. Show the target chat name, type, and ID, then require an explicit **Approve chat** action. Opening a link, resolving metadata, and signing in must not mutate policy or consume the request.
- Use authenticated same-origin JSON POST endpoints with existing Origin, session, body-size, and CSRF checks. Bind approval to the stored request and current policy revision; never trust a client-supplied chat ID.
- Commit request consumption, list membership, any required `enabled: true` override, policy revision, and audit record in one transaction. Refactor the existing transaction boundary if needed; do not nest the transaction in `AdminStore.save`.
- Preserve unrelated chat settings and global capability ceilings. Approval does not enable shell, file tools, MCP servers, or models outside the existing defaults and ceilings.
- On revision conflict, leave the request usable and ask the administrator to reload and review. On duplicate or replayed approval, do not add a second revision or audit mutation. A revoked chat must not be reapproved by replaying a consumed link.
- Submit the saved revision to the existing application worker. Show pending, applied, or failed status accurately; database commit alone is not runtime acceptance. Do not restore revoked access after application failure.

### Existing environment IDs

- Keep initial import behavior for new databases during this stage.
- For existing databases, compute a bounded, deterministic reconciliation report for environment IDs: already present, missing, and explicitly disabled. Expose it only through authenticated administration and record its reviewed completion in SQLite.
- Do not silently union missing environment IDs into a live policy. An absent ID can be a deliberate WebUI revocation, and existing data cannot reliably distinguish it from an ID added later to the environment.
- Let the administrator explicitly select missing IDs for import and retain existing revocations. Use the current revision, existing limits, atomic audit writes, and normal application worker. Record retained denials as reviewed decisions.
- Do not overwrite per-chat models, tools, providers, or other settings. Do not automatically repeat a completed reconciliation on restart. If the environment input changes before Stage 2, show a new review requirement.
- Positive IDs authorize private chats only. An approved private sender must not authorize an unapproved group.

## Plan

- [x] Define the request schema migration, endpoint contracts, and policy transaction boundary in the existing admin files; review them against expiry, concurrency, restart, and rollback cases before implementation.
- [x] Add bounded request storage, expiry cleanup, and hash-only token lookup in the admin store; prove persistence, replacement, cooldown, capacity, and one-use behavior with store tests.
- [x] Add `/allow` before Telegram authorization middleware and include it in help; use synthetic Telegram updates to prove it works for denied chats without starting model work or bypassing other checks.
- [x] Add authenticated request resolution and approval endpoints in `apps/bot/src/admin/server.ts`; prove CSRF, Origin, session, request binding, expiry, conflict, and replay protection in server tests.
- [x] Add the pending-request sign-in and confirmation UI in `apps/admin/src/`; prove fragment removal, tab persistence, safe rendering, confirmation, and application status in unit and browser tests.
- [x] Add environment reconciliation reporting and explicit import review in the existing admin import and policy flow; test new databases, existing databases, retained revocations, changed environment input, restart, and concurrent edits.
- [x] Update `docs/admin-webui.md`, the relevant READMEs, and `.env.example` with `/allow`, locality limits, reconciliation, and the Stage 2 prerequisite; add package changesets for `@narumitw/sumire` and `@narumitw/sumire-admin`.
- [x] Run workspace-scoped bot and admin tests plus admin browser tests during iteration; run all root checks listed below before publication and record results.
- [ ] Back up deployment state, deploy Stage 1, and have the administrator test the flow with a real Passkey and Telegram private chat and group; record evidence without tokens or personal chat data.
- [ ] Review every configured environment ID against the active database and record each as approved or intentionally denied; verify the reviewed policy survives restart before Stage 2 is eligible.

## Implementation contracts and evidence

- Schema version 3 adds `chat_access_requests` and `access_reviews`. Version 2 upgrades retain existing policy, Passkeys, and sessions. `AdminStore.save` accepts a synchronous persistence callback inside its existing transaction; rollback tests prove request consumption and review records cannot commit separately from policy and audit.
- `POST /api/access/resolve` accepts only `{ token }` and returns bound chat metadata, expiry, and current revision without mutation. `POST /api/access/approve` accepts only `{ token, revision }`. Invalid or expired links return 410, invalid input returns 400, and stale revisions return 409. Both require administrator session, Origin, JSON, and CSRF checks.
- `GET /api/access/reconciliation` returns the bounded sorted report, environment fingerprint, revision, and previous review. Its POST accepts only `{ fingerprint, selected, revision }`; selections must be missing IDs. Policy and retained decisions commit together before normal application.
- Browser intent capture handles initial URLs and hash-only navigation in an existing tab. Token-keyed components prevent display of a previous target while a replacement resolves. Late approval responses cannot clear a newer intent. Tests cover disabled browser storage, invalidation, expiry, explicit confirmation, virtual Passkey sign-in, stale revisions, and failed application.
- Root format, lint, typecheck, test, and build checks pass. The unit/integration suite has 1,362 passing tests across six workspaces. All 36 admin browser tests and both production-asset local HTTP / offline HTTPS smoke scripts pass. Final checks ran on Node.js 26.10.0 after the lifecycle fixes; all required commands returned exit code 0. PR publication is recorded in the execution handoff.
- Diff review covers transaction correctness, hash-only storage, authentication and CSRF boundaries, UI request lifecycle, schema compatibility, legacy-mode preservation, and scope. No production state, credentials, model/provider calls, or Stage 2 sources were changed.
- Existing dependency risk: `npm ci` / `npm audit` reports one critical transitive `handlebars` dependency. This change adds no dependencies and does not repair that unrelated advisory. The build also reports upstream Radix `use client` bundling warnings without failing.

## Publication

- Draft pull request: <https://github.com/narumiruna/sumire/pull/95>, based on `main`.
- The implementation is pushed on `narumi/feat/chat-allow-links`. The draft status records the deployment acceptance blockers below; it does not mark those checks complete.
- The unrelated Stage 2 plan and original documentation-only changeset remain unchanged outside this PR.

## Blocked deployment acceptance

- A deployment operator must stop and back up the actual state, retain the matching image, deploy Stage 1 through the repository-root Compose workflow, and record rollback readiness. No production backup or deployment was performed by this implementation.
- The configured administrator must use a real Passkey on the configured origin and request/approve access from real Telegram private and group chats. Virtual authenticator and synthetic update evidence is not a substitute.
- The administrator must review every configured environment ID in the deployed WebUI, confirm imports and retained denials, restart, and verify both approved and denied chats. Do not store personal IDs, tokens, or backup paths in this document.
- Keep the remaining tasks and completion checks open until this evidence exists. Keep this plan; do not claim Stage 1 production completion or begin Stage 2 based only on the PR.

## Rollback / Recovery

- Stop the bot before backing up or restoring `.telegramagent/admin.sqlite`. Retain the matching application image and existing credential/session state backups under private access controls.
- Version additive schema changes and preserve the current refusal of newer database schemas. If an older image cannot read the new schema, restore its matching pre-upgrade state instead of forcing it to open the database.
- Before reopening access after restoration, review permissions: an older policy or legacy environment branch can restore revoked access. Pending links from the newer deployment must not remain valid on the restored deployment.
- Keep the existing `/admin` bootstrap and documented Passkey recovery path. A chat request token must never replace either path.

## Completion Checklist

- [x] `/allow` returns a bounded request link in supported chats; no ordinary denied input produces a link or model turn.
- [ ] Real Passkey sign-in retains the request; only explicit authenticated confirmation grants the bound chat access.
- [x] Tests reject token tampering, chat substitution, wrong origins, CSRF, expiry, replacement, replay, and policy conflicts; no token appears in persistent logs or audit data.
- [x] Approval changes only the target chat's access, uses the application worker, and preserves capability ceilings and explicit failure states.
- [ ] Reconciliation records cover all deployment environment IDs, preserve intended denials, and survive restart without automatic regranting.
- [x] `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, admin browser tests, and `git diff --check` pass; unavailable live checks remain open with their required operator action.
- [ ] Documentation, affected-package changesets, backup evidence, and administrator deployment acceptance are recorded before Stage 2 starts.
