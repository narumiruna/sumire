# Stage 2: Remove BOT_WHITELIST

## Goal

Remove environment-based chat authorization. Use the existing SQLite administration policy as the only source of chat access, with `/allow` and authenticated WebUI approval for new chats.

Implementation and automated checks are complete on `narumi/refactor/database-only-chat-access`, based on `main` after PR #95. The new image is deployed; final post-upgrade operator acceptance remains open. Stage 1's acceptance gate passed on 2026-10-15 with the operator reports and live checks below. Stage 2 deployment acceptance remains separate.

## Context

`BOT_WHITELIST` is not limited to Telegram middleware. Current uses include:

- `apps/bot/src/config/settings.ts`: environment parsing and `Settings.botWhitelist`.
- `apps/bot/src/startup.ts`, `admin/store.ts`, and `admin/policy.ts`: initial database seeding.
- `apps/bot/src/telegram/bot.ts`: the no-admin authorization branch and `isAllowed` helper.
- `apps/bot/src/agent/pi-session-factory.ts`: the trusted-ID startup guard, image access, and session policy fingerprint.
- `apps/bot/src/agent/read-image.ts`: the default allowed-chat set.
- `apps/bot/src/agent/model-runtime.ts`: administrator and model startup conditions.

Today the administration store is created only when WebUI administration is enabled. Removing the environment branch must not create a new allow-all or store-optional runtime.

## Architecture

- Keep SQLite at `.telegramagent/admin.sqlite`. Do not change database engines, paths, existing chat records, policy revisions, or Passkey ownership.
- Require `BOT_ADMIN_ID` for the supported bot startup path so the administration store and approval/recovery route are always available. Keep `ADMIN_ORIGIN` optional: the existing localhost default remains valid. Document this configuration change as breaking behavior.
- Construct and apply the administration store before admitting chat work. Missing administrator configuration, unavailable storage, invalid policy, and pending or failed revisions must deny work; do not fall back to environment authorization.
- Require the store or an explicit database-backed authorization dependency at production admission and tool-access boundaries. Remove optional dependencies that previously selected legacy behavior. Tests must not rely on an implicit permissive default.
- New databases start with empty chat access lists. `BOT_ADMIN_ID` allows administrator bootstrap, not automatic model/tool access. The administrator can use `/admin` to enroll a Passkey, then `/allow` to approve their private chat.
- Retain the narrow pre-authorization `/admin` and `/allow` handlers. All other commands, model turns, attachments, passive context, channel indexing, recovery, restored work, and tool calls use current database policy.
- Image reads use current database-backed source-chat permissions at invocation. A private user's approval does not authorize images or work in other groups or channels.
- Remove the environment parser field, settings property, startup seeding parameter, legacy checks, policy fingerprints, and Stage 1 environment-reconciliation entry points. Preserve reconciliation reports and audit history already stored in the database.
- Keep a tested, versioned migration path for supported existing database schemas, but do not read environment IDs to populate new databases or automatically restore old permissions.
- Old deployment environments may still contain `BOT_WHITELIST`; treat it as an unused unknown variable, not an access source. Test that it grants no access. Update deployment configuration to remove it after the gate below passes.
- Do not change global capability ceilings, provider credentials, transcript storage, or the existing policy application worker.

## Non-Goals

- PostgreSQL, multi-instance database coordination, multiple administrator accounts, password login, and new channel onboarding commands.
- Removing the stored private-user or group access lists. The change removes the environment variable, not chat authorization.

## Plan

- [x] Verify Stage 1 acceptance, real Passkey access, `/allow`, and reviewed environment-ID reconciliation for the target deployment; record an explicit go/no-go decision before removing any configuration. Evidence: acceptance record below.
- [x] Inventory remaining production and test references with `rg -n 'BOT_WHITELIST|botWhitelist' apps packages .env.example compose.yaml README.md docs`; classify historical plan/release records separately from active code and guidance.
- [x] Require `BOT_ADMIN_ID` and unconditional administration-store initialization in settings and startup; prove missing configuration and store failures stop admission while default localhost setup still works.
- [x] Remove whitelist seeding from store construction and `initialPolicy`; test empty new databases and unchanged upgraded policies, including intentionally disabled chats and retained import reports.
- [x] Remove the legacy Telegram authorization branch and require database-backed authorization; prove private, group, supergroup, channel, sender-ID, attachment, and passive-context behavior remains fail-closed.
- [x] Replace legacy factory, image-reader, and model-runtime checks with the existing database policy path; test restored work, source-chat image access, policy changes, runtime failure states, and permission cache invalidation without recreating an agent loop.
- [x] Remove Stage 1 environment reconciliation inputs and UI actions while retaining stored reports and audit history; verify restarts cannot reimport or regrant removed IDs.
- [x] Update shared fixtures and affected tests to use explicit admin configuration and persisted policies rather than `botWhitelist`; prove that setting an obsolete environment variable alone grants no chat access.
- [x] Remove the variable from `.env.example` and active deployment/setup guidance; document required `BOT_ADMIN_ID`, empty first-start access, `/admin`, `/allow`, and rollback risks. Keep historical release records accurate rather than rewriting them.
- [x] Add changesets for every affected package; select the version bump using the repository's release policy and explicitly describe the configuration incompatibility.
- [x] Run focused bot/admin checks, admin browser tests if frontend code changes, and all root checks below; review the final reference inventory so only intentional historical or negative-test references remain.
- [ ] Back up and stop the deployment, remove the obsolete environment setting, deploy the new image, and verify approved/denied chats plus `/admin` and `/allow` after restart; record operator acceptance without credentials or personal chat data.

## Stage 1 acceptance and go/no-go

- **GO for Stage 2 implementation**, 2026-10-15: the administrator reported successful real Passkey access, private and group `/allow`, and continued access after the authorized restart. These are operator reports, not virtual-authenticator evidence.
- Read-only deployment checks confirmed schema version 3, environment access review at revision 5, and an applied policy at revision 8. All 21 environment IDs were present before review. Private approval was accepted from the operator's explicit report; the audit independently confirmed group approvals only.
- With operator approval, the bot was stopped, its administration state, event state, working directory, runtime environment configuration, Compose configuration, and MCP source were copied to a private backup outside the repository, and the same container was restarted.
- Before/after comparison proved identical full policy, authorization epoch, Passkeys, and access reviews. SQLite integrity was `ok`; saved/applied revision remained 8 and the container was healthy. The administrator then confirmed real Passkey sign-in and bot use after restart.
- The deployment did not retain its source `.env`; the backup contains the container's actual environment instead. No credentials, private URLs, chat IDs, or backup contents are included here. This is a Stage 1 state backup for Stage 2 recovery, not evidence of a pre-Stage-1 backup.
- Stage 2 must still preserve permissions and pass its own upgrade/restart checks. Do not describe the Stage 1 results as Stage 2 production acceptance.

## Stage 2 implementation and verification

- Production settings and deployment workflow no longer read the obsolete variable. `BOT_ADMIN_ID`, the administration store, Telegram admission, session-registry admission, Pi session creation, and source-channel image reads have no environment-based or store-optional fallback.
- New policies start empty. Versioned schema migration remains at version 3 and preserves saved grants, explicit denials, Passkeys, sessions, and import/review history. Reconciliation mutations and UI controls are removed; authenticated import reports expose the latest 10 archived access reviews without changing stored history.
- Asynchronous session creation rechecks current authorization before caching a session and disposes a revoked creation. Source-image reads recheck access after index reads and after downloads. Tests cover these races, unavailable storage, absent administrator configuration, unknown chats, pending/failed revisions, obsolete malformed input, restoration, and retained capability ceilings.
- Existing unit fixtures now seed finite, explicit SQLite policies. Only test helpers can seed access; production constructors accept no seed list. Legacy automatic model fallback tests were replaced with explicit database model selection and retained per-chat settings after reset/restart.
- All root checks passed on Node.js 26.10.0: `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test` (1,369 tests across six workspaces), and `npm run build`. All 36 admin browser tests passed.
- Production-asset HTTP/Passkey and offline HTTPS smoke checks passed. The native Pi worker/WASM, tool, persistence, timeout, and recovery smoke passed both locally and in the built container. Container HTTPS smoke ran without network, credentials, or production volumes.
- Reference inventory leaves only negative tests, historical plans/release records, and explicit removed-setting migration guidance. Package changesets cover the bot, admin frontend, and URL-content documentation. The obsolete deployment workflow input is removed.
- Complete diff review covered authorization correctness, authentication/CSRF preservation, asynchronous session/image lifecycle, schema and bootstrap compatibility, retired behavior versus retained regression coverage, and scope. All 11 changed production JavaScript module hashes match the deployed image.
- Existing dependency audit still reports a critical transitive `handlebars` advisory; this change adds no dependencies. Upstream Radix bundling warnings are non-fatal.

## Publication

- Draft pull request: <https://github.com/narumiruna/sumire/pull/96>, based on `main`.
- Implementation commit: `9f3168d` on `narumi/refactor/database-only-chat-access`.
- The original documentation-only changeset remains unchanged outside this PR. No package publication, version tag, or release workflow was initiated.
- The draft records the post-upgrade operator acceptance still required below; it does not waive that condition.

## Stage 2 deployment evidence and remaining acceptance

- The Stage 1 image was archived and gzip-checked under private access controls. A stopped-service checkpoint captured administration state, events, and working files immediately before upgrade; original runtime environment and mount configuration were retained for rollback. No backup path, token, private URL, or personal chat ID is committed.
- Built and deployed the Stage 2 image through repository-root Compose, preserving the existing volume names and bind mounts. A failure trap retained the Stage 1 configuration as the rollback target; no restore or rollback was needed.
- The live container is healthy, uses schema version 3, has no obsolete access variable, and denies unauthenticated settings requests. Its new-database bootstrap check requires an administrator and ignores obsolete values without granting access.
- Exact pre/post-upgrade comparison passed for full policy, authorization epoch, Passkeys, and environment reviews. Saved/applied revision stayed 8; existing access counts stayed one private chat and 23 group/channel chats. SQLite integrity was `ok`.
- Read-only live checks confirmed that unknown private and group chats remain denied by the applied policy. This is database-policy evidence, not a substitute for real Telegram transport testing.
- **Pending operator action:** verify real Passkey sign-in, existing approved/denied chats, `/admin`, and `/allow` after the Stage 2 upgrade. The prior Stage 1 confirmation does not complete this check. Keep the deployment task and final completion check open until the operator reports these results.
- Retain this plan while acceptance is incomplete. Do not claim end-to-end completion from automated tests alone.

## Rollback / Recovery

- Before deployment, back up the SQLite state and retain the Stage 1 image and private deployment configuration. Review the administrator's ability to sign in before removing the environment variable.
- Roll back to the Stage 1 image and a compatible database snapshot with administration enabled. Restore an older snapshot only while the bot is stopped and only after reviewing permissions changed since that snapshot.
- Do not disable administration to recover access: doing so on an older image can restore legacy sender-based or environment-based authorization. Do not restore a stale whitelist without review.
- An intentionally empty allowlist remains empty. Restore operator access through the existing Passkey recovery and `/admin` bootstrap path, then approve the intended chat through `/allow`; do not introduce an allow-all or password bypass.

## Completion Checklist

- [x] Stage 1's deployment and reconciliation prerequisites have explicit acceptance evidence.
- [x] No production source reads `BOT_WHITELIST` or `botWhitelist`; old environment values do not grant access, and active setup guidance no longer recommends them.
- [x] Startup requires administrator configuration and a valid administration store; missing configuration, failed storage, and unavailable policy never admit work.
- [x] Existing approved chats and intended revocations persist after upgrade and restart. New databases deny chats until authenticated approval.
- [x] `/admin` and `/allow` work before chat approval without granting model/tool access. Passkey sign-in, approval, and administrator recovery remain available.
- [x] Regression tests cover Telegram admission, source-chat image access, restored work, runtime revocation, and capability ceilings with database policy only.
- [x] `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, applicable admin browser tests, and `git diff --check` pass; any unavailable deployment checks remain open with an operator action.
- [ ] Affected-package changesets, configuration migration guidance, backup evidence, and post-deployment administrator acceptance are recorded.
