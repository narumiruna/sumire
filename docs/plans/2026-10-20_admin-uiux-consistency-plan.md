# Administration UI consistency plan

## Goal

Make the save state, primary action, controls, and section structure clear without changing behavior, save boundaries, APIs, or permissions.

## Status and evidence

Implementation commit `e6865d6` and follow-ups `f94b712` and `6d0176d` record the shared surfaces, single-status save bar, control consistency, guided MCP editor, and error boundaries. Recorded verification passed 168 admin unit tests, 233 browser tests, 1,838 root tests, and all five root checks. These are historical results, not checks rerun during documentation cleanup.

The app uses explicit light appearance. [The administration guide](../admin-webui.md) retains the behavioral contract. Later redesigns do not establish user acceptance of this pass.

Historical comparison artifacts were recorded under `/tmp/sumire-admin-consistency-rapid-forest/`. Their current availability is not verified.

## Plan

- [x] Implement all 18 recorded consistency findings with unit/browser regressions and unchanged security, save-state, and lifecycle assertions.
- [x] Record before/after captures at 1440, 390, and 320 pixels, contrast measurements, root checks, documentation, and the admin package changeset.
- [ ] Record the required comparison review and resolve its findings. Blocked on the review below.

## External Handoff

The administrator must review the save bar, panel treatment, and MCP steps against the synthetic before/after captures. Expected result: the state and next action are clearer than the baseline. If the historical captures are unavailable or no longer represent the current UI, record that limit and obtain an explicit disposition instead of claiming acceptance. Automated geometry and contrast checks do not establish subjective clarity. No live provider, device, or production acceptance is claimed.

## Completion Checklist

- [ ] User review confirms the revised save bar, container treatment, and MCP steps, or explicitly records the disposition of the superseded presentation.
- [ ] Resolve material findings and retain the review result before deleting this plan.

## Rollback / Recovery

Revert the frontend presentation change and rebuild. No database rollback, session reset, or policy migration is required.
