# Image generation and Telegram delivery plan

## Goal

Generate an image from an authorized natural-language request and deliver its validated bytes to the originating Telegram chat.

## Status and evidence

Implementation `0e1496e` and follow-ups `9731d9a` and `b5fa6fc` provide the client, bot capability, image-first delivery, persisted media receipts, and corrected tool availability. Commit `4ef5d7f` records the availability-fix verification: all five root checks, 2,066 tests, and twelve focused browser tests passed. These are historical results, not checks rerun during documentation cleanup.

Protocol, bounds, and experimental access limits are documented in [the imagegen package](../../packages/imagegen/README.md). Generation requires compatible bot-owned `openai-codex` OAuth and explicit tool authorization. API keys, the separate `openai` OAuth flow, another provider, or configured credentials alone do not establish image access.

Dependency, build-order, lockfile, Docker, and CI configuration changes are present. Static checks and host imports do not establish the final production-image/non-root import gate. The original build attempt failed because the Docker daemon was unavailable; later intermediate-stage build evidence is not a final-image result.

## Plan

- [x] Implement bounded generation, provenance-bound artifacts, additive outbox/media receipts, image-first photo/document delivery, and recovery without regeneration.
- [x] Test direct/codemode invocation, image-only output, forks, compaction, restart, partial delivery, cancellation, reset, and auth revocation; document setup and package changes.
- [ ] From the repository root, run `docker compose --progress plain build sumire` and verify the compiled package imports as the final non-root runtime user without credentials or a live request. Record actual results; this agent-executable gate remains open.
- [ ] Record authorized live Codex access and controlled Telegram photo/document delivery, as described below.

## External Handoff

The account owner must provide compatible bot-owned Codex OAuth and approve one image request's quota use. The Telegram administrator must provide a controlled destination and authorize the send. Expected result: an authorized natural-language request produces actual image bytes delivered to the originating chat, with document upload when photo constraints require it.

No successful live generation/delivery is recorded. Stop after one clear entitlement or endpoint failure and record only sanitized outcomes. Do not use this coding session's credentials, switch endpoints/accounts, or retry generation automatically. An unresolved live-access blocker keeps feature acceptance incomplete. A full runtime image and deployment approval are prerequisites, not evidence of live success.

## Completion Checklist

- [ ] Record a passing full Compose build and offline non-root package import.
- [ ] Verify compatible Codex OAuth image access without credential fallback.
- [ ] Record actual Telegram image delivery and required photo/document behavior with approved quota/send use.
- [ ] Preserve sanitized verification results and unresolved limits before deleting this plan. Do not close it while a required item remains open.

## Rollback / Recovery

Before rollout, take a consistent backup of the admin database, per-chat durable databases, and pending image artifacts. Disable `generate_image` through existing tool policy to stop new generation.

Prefer draining pending media with a compatible fixed build. An older binary may not safely acknowledge media-bearing records; review compatibility or restore the matching pre-rollout snapshot. Preserve pending files. Do not regenerate an image to repair delivery. A lost Telegram response before a local receipt can cause a duplicate; local cancellation does not guarantee remote cancellation or a quota refund.
