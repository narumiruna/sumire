# Administration usability plan

## Goal

Make saved, draft, and applied state clear across the administration UI while preserving independent saves, permissions, and recovery behavior.

## Status and evidence

Implementation commits `cff5f69` and `a53b62f` are supported by [Administration usability validation](../admin-usability-validation.md). That record retains focused frontend/backend tests, browser results, all five root checks, responsive/keyboard/zoom checks, contrast measurements, and verification limits.

All implementation tasks have recorded evidence. Required user acceptance remains open. Later redesigns do not establish acceptance of this iteration, and no checks were rerun during documentation cleanup.

## Plan

- [x] Implement persistent save/application state, readiness, scoped workflows, guided MCP/provider editing, bounded audit filters, and cross-section consistency.
- [x] Record tests, accessibility measurements, documentation, affected-package changes, and rollback guidance in the validation document.
- [ ] Record user review of the delivered status/readiness flow and remaining sections. Blocked on the review below.

## External Handoff

The administrator must review the persistent status/readiness presentation and the remaining administration sections with synthetic fixtures. Expected result: saved, draft, and applied state and each save boundary are clear. Automated tests and measured contrast do not establish subjective acceptance. Record unresolved findings and the disposition of any presentation replaced by later work. Deployment and live setting changes require separate authorization.

## Completion Checklist

- [ ] Record explicit user acceptance and resolve or explicitly accept material findings.
- [ ] Preserve the review outcome in the validation document before deleting this plan.

## Rollback / Recovery

Revert the frontend or use a compatible previous image. Do not restore an old policy snapshot for a visual rollback: it can restore revoked access. A display rollback does not undo credential changes or external effects. Check actual saved/applied revisions and access before reopening administration traffic.
