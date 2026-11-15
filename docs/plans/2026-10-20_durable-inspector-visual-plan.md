# Admin WebUI visual refinement

## Goal

Apply the approved Durable Inspector visual direction to all eight administration pages without changing APIs, save scopes, or bounded read-only inspection.

## Status and evidence

Implementation commits `6285995` and `ffbf001` record the production Durable workspace and shared Radix presentation. Commit `f19fa45` records final validation. The recorded results passed 177 admin unit tests, 273 browser tests, 1,855 root tests, all five root checks, and CI run `39458768485`. These are historical results, not checks rerun during documentation cleanup.

[The administration guide](../admin-webui.md) documents behavior and limits. Historical synthetic captures were recorded under `/tmp/sumire-allpages-visual/`; their current availability is not verified. Later redesigns are not evidence of acceptance of this iteration.

## Plan

- [x] Apply the visual direction to the shell, Chats, Access, Defaults, Tool permissions, MCP connections, Model providers, and Audit.
- [x] Verify responsive layouts, contrast, keyboard access, request limits, draft retention, save boundaries, and all-page coverage; record documentation and package changes.
- [ ] Record user acceptance of the visual result. Blocked on the review below.

## External Handoff

The administrator must review the implemented pages against the approved visual direction using synthetic data and available captures. Expected result: readable controls and the agreed visual hierarchy. Automated tests do not establish subjective acceptance. Record the disposition of any presentation replaced by later work rather than infer approval. No deployment, real-device, Telegram, or provider acceptance is claimed.

## Completion Checklist

- [ ] Record explicit user acceptance or an explicit disposition of the superseded visual iteration.
- [ ] Resolve material findings and retain the review result before deleting this plan.

## Rollback / Recovery

Revert the frontend visual change. Preserve bounded entry-content access and read-only storage ownership. Do not reset conversations or restore a database for a display change.
