# Task-centered administration UI

## Goal

Let an administrator identify a chat's known state, blocking reason, and next action. Preserve authorization, policy resolution, and independent save boundaries.

## Status and evidence

Implementation and review evidence are retained in [Task-centered administration validation](../admin-task-centered-validation.md). The recorded results include 273 admin unit tests, 306 browser tests, and passing formatting, lint, typecheck, and build checks. The default root test retry failed in ten unchanged bot timing cases; the complete two-worker rerun passed 1,969 tests with unchanged cases and timeouts. These are historical results, not checks rerun during documentation cleanup.

The delivered behavior includes a shared saved-state resolver, repair links, compact clean save state, scoped policy review, and retained directory state. Local configuration does not prove successful remote model execution.

## Plan

- [x] Implement the shared state/action contract, scope labels, navigation, directory density, and policy-review changes with regression tests.
- [x] Record fixture evidence, CI corrections, root results, documentation, package changes, and recovery limits in the validation document.
- [ ] Record the required user flow review and resolve its findings. Blocked on the review below.

## External Handoff

The administrator must review the fixture-backed flow and identify current status, blocking reason, and next action; stage a setting, review it, cancel it, and return to the previous search. Expected result: the state and flow are unambiguous, with unrelated drafts preserved. Automated fixture success does not establish user acceptance. Live setting changes, real provider checks, and deployment need separate authorization. Later redesigns do not establish acceptance of this iteration.

## Completion Checklist

- [ ] Record explicit user acceptance and resolve or explicitly accept all material findings.
- [ ] Preserve the review result in the validation document before deleting this plan.

## Rollback / Recovery

Revert the frontend change or use the preceding compatible build. Do not restore an older policy database for a visual change. Warn before reload: a revert does not recover unsaved browser drafts.
