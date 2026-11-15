# Codemode support plan

## Goal

Let Pi use native codemode with existing tool authorization, deadlines, cancellation, progress, and image support.

## Status and evidence

The original implementation `a55f74f` records passing root checks, 809 tests, and an isolated non-root production-image smoke covering worker/WASM execution, tools, progress, persisted stores, deadlines, and recovery. No live provider or Telegram request was made.

Native Durable integration now supersedes the original runtime design. Current behavior is documented in [Codemode](../../apps/bot/README.md#codemode) and [the native upgrade guide](../pi-durable-native-upgrade.md). Codemode is enabled by default; the old enable flag and inline-runtime rollback are obsolete. These later changes do not prove live compatibility or accepted deferral. No checks were rerun during documentation cleanup.

## Plan

- [x] Implement and fixture-test codemode, persisted deadlines/stores, tool boundaries, progress, cancellation, and recovery.
- [x] Record root checks, isolated image smoke, documentation, package changes, and safety review.
- [ ] Record authorized live provider/Telegram verification or explicit user agreement to defer it, including the disposition of the original activation restriction.

## External Handoff

The account owner and deployment operator must provide a controlled runtime/Telegram target and separately authorize model quota and message sends. Verify a direct tool call, nested codemode call, cancellation, and reply/recovery behavior without repeating confirmed side effects. Expected result: correct tool authorization, bounded execution, and delivery to the originating chat. Fixture success does not establish live compatibility.

The original handoff required draft status and disabled production activation until verification or accepted deferral. The flag no longer exists, and later merges/default enablement are not acceptance evidence. The owner must explicitly resolve that restriction through current policy/deployment controls; this cleanup does not change runtime configuration or waive the gate.

## Completion Checklist

- [ ] Record live provider/Telegram evidence or explicit accepted deferral with its reason.
- [ ] Record the owner disposition of the original draft/activation restriction.
- [ ] Preserve the handoff outcome before deleting this plan.

## Rollback / Recovery

Follow the native upgrade guide with a consistent backup and compatible image. Preserve legacy cleanup tasks and state volumes. Cancellation does not reverse completed effects; inspect effects and obtain authorization before retry or recovery. Do not restore removed environment switches.
