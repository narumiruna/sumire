# Passive context and Logfire safety

## Goal

Keep passive context from starting or steering model turns, prevent credential-bearing telemetry, and preserve the unresolved production incident response.

## Status and evidence

The original 2026-09-29 incident record confirms Telegram bot-token exposure in telemetry. Code remediation is recorded in `04beab6`, `9158ce0`, `112ba0c`, and later `f7acd70`. Current passive-context and logging tests cover turn isolation, ordering, restart, streaming, sensitive exceptions, and HTTP credential suppression.

The original plan records passing installation, formatting, lint, typecheck, test, and build checks and a bot patch changeset. These are historical results, not checks rerun during documentation cleanup. Production containment, old-token revocation, and historical-record disposition have no completion evidence in this plan. Do not report the incident as resolved.

## Plan

- [x] Implement passive-context isolation and disable sensitive HTTP/undici instrumentation, with deterministic regressions and package documentation.
- [x] Record historical root-check and changeset evidence.
- [ ] Record the operator incident-response results below without credentials, trace payloads, or conversation content. Blocked on authorized account and deployment owners.

## External Handoff

- **Logfire owner:** stop unsafe Logfire export under operator control before any token replacement or accepted revocation delay. Verify that export has stopped. With authorized incident access, establish the exposure window and account/read-access scope. Inspect sanitized exported fields. Record the decision and result for access restriction, retention, or deletion of historical sensitive records. Expected result: no new credential export and an explicit historical-data disposition. Actual production export and historical cleanup remain unverified.
- **Telegram account owner:** a replacement token on the unpatched service could enter the same telemetry path. Do not deploy a replacement until unsafe export has stopped and the patched path is verified safe. Record any existing proof that the old token is revoked. Otherwise, use one of these paths:
  1. Revoke the exposed token through BotFather at once. Accept bot downtime until a safe replacement is deployed.
  2. If the account owner explicitly accepts a delay, first confirm that unsafe export has stopped. Record the risk approval, reason, named revocation owner, and a UTC revocation deadline. A copied token remains usable until revocation. Revoke it by that deadline even if rollout is delayed.

  Expected result: the old credential is unusable and the replacement is not exported. Containment, rotation, and revocation remain unverified.
- **Deployment operator:** create a protected consistent state backup before authorized rollout. In an approved test group, verify passive-context isolation, an addressed public-URL request, Telegram delivery, reply-tree behavior, and session continuity. Expected result: correct routing and safe telemetry with no credential-bearing fields. Production behavior remains unverified.

The existing guidance is under [Operator verification and historical data](../../apps/bot/README.md#operator-verification-and-historical-data). No login, credential rotation, telemetry deletion, deployment, or live request is authorized by documentation cleanup. Do not copy secrets or raw traces into the repository or issue records.

## Completion Checklist

- [ ] Record production containment, exposure/access assessment, and safe-export verification.
- [ ] Record token rotation and old-token revocation.
- [ ] Record historical-record disposition and controlled-group verification.
- [ ] Preserve sanitized incident outcomes before closing this plan; do not declare overall resolution while required external actions remain unverified.

## Rollback / Recovery

Preserve state backups and credential suppression. Do not restore an exposed token or re-enable unsafe telemetry during rollback. A code revert does not repair previously exported records.
