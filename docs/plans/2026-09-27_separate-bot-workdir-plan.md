# Separate bot working directory

## Goal

Keep mutable Pi tool files in `/workdir`, separate from application code and runtime resources under `/app`.

## Status and evidence

Implementation commit `a4443be` separates the workdir mount, process working directory, home directory, and application entrypoint. Current `compose.yaml` and `Dockerfile` retain this separation. Session-factory and registry tests cover separate tool writes and stale reply mappings.

Pi Durable has replaced the original JSONL runtime. `BOT_WORKDIR` is no longer a supported switch. These source changes do not establish deployment-host migration or backup acceptance.

## Plan

- [x] Implement separate image and workdir paths with regression coverage.
- [ ] Record the deployment inventory, protected backup evidence, isolated recreate/persistence checks, and operator rollout/rollback acceptance described below. Deployment-state checks remain unverified; do not infer them from later merges.

## External Handoff

The deployment operator must:

1. Before an authorized migration, identify the actual deployment volumes and create a readable, consistent state backup in protected off-repository storage. Preserve ownership, permissions, events, and Whisper cache.
2. Use an isolated test deployment and fresh workdir to verify that the matching image reads instructions/skills from `/app`, writes tool files in `/workdir`, and retains those files across recreation. Verify all separate state/events/cache mounts.
3. Check legacy-session archival and reply-checkpoint behavior using the matching runtime; do not resume old checkpoints merely because their files exist.
4. Record sanitized backup, smoke-test, and rollout/rollback results before production migration acceptance.

These operations require deployment access and approval. Local tests do not prove production persistence or recoverability. See [Docker setup and recovery](../../apps/bot/README.md#docker).

## Completion Checklist

- [ ] Record a readable protected backup and the deployment volume inventory.
- [ ] Record recreate/persistence, resource-path, session/reply, and separate-mount results.
- [ ] Record operator acceptance before closing this migration plan.

## Rollback / Recovery

The original operator report states that the old workdir volume was deleted. Do not assume its files or SSH keys are recoverable. Restore required files from a protected backup or regenerate keys securely.

Use a compatible image/configuration and preserve volumes. Recreating an old mount does not restore deleted files. Review state compatibility and subsequent messages before restoring any backup. Never use `docker compose down -v` for rollback.
