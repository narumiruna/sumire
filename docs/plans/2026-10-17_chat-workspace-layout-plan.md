# Chat workspace layout plan

## Goal

Correct chat layout and readiness presentation without changing policy, APIs, permissions, or configuration semantics. Investigate Access and History tab behavior before changing tab handlers.

## Status and evidence

Implementation and automated checks are recorded in [Chat workspace validation](../admin-chat-workspace-validation.md). The final recorded run passed 136 browser tests, 1,475 root tests, and all five root checks. These are historical results, not checks rerun during documentation cleanup.

Automated tests did not reproduce the reported tab failure. Tab handlers and state logic were not changed. Manual verification remains open; later UI changes do not establish that this check passed.

## Plan

- [x] Implement directory scrolling, stable titles, readiness details, and scroll-restoration fixes with regression coverage. Evidence: the validation record and `apps/admin/tests/chat-workspace.spec.ts`.
- [x] Record automated results, screenshot locations, review findings, and verification limits in the validation record.
- [ ] Record manual Access/History verification or explicit user acceptance of the unavailable check. Blocked on the review described below.

## External Handoff

The administrator or browser reviewer must use an available manual browser and an isolated fixture to repeat Access and History clicks, keyboard navigation, and chat switching. Expected result: the matching panel opens and the selected tab remains consistent. The original Chrome DevTools executable was unavailable; headless results do not verify manual behavior. No live setting change or production deployment is authorized by this plan.

## Completion Checklist

- [ ] Manual tab verification has evidence, or the user explicitly accepts its absence.
- [ ] Record the result and resolve any findings in the validation document before deleting this plan.

## Rollback / Recovery

Revert the frontend layout change if required. Do not restore an older policy database for a display change.
