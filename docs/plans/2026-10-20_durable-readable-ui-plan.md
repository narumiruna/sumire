# Durable UI readability plan

## Goal

Let an administrator identify the inspected conversation, its relationship to persisted selection, and its recorded task outcomes without reading JSON.

## Status and evidence

Implementation commit `ed32d1c` records the readable views and navigation fixes. Its recorded verification passed 153 admin unit tests, 206 browser tests, 1,823 root tests, and all five root checks. These are historical results, not checks rerun during documentation cleanup.

The current behavior and read limits are documented under **Durable Inspector** in [the administration guide](../admin-webui.md). Later changes are recorded in [chat-centered Durable validation](../chat-centered-durable-validation.md) and [Conversation History validation](../conversation-history-validation.md). They do not establish the outstanding user acceptance.

## Plan

- [x] Implement readable task/document views and correct historical-conversation targeting and direct Conversation ID lookup, with navigation regressions.
- [x] Verify bounded explicit reads, unchanged persisted selection, cancellation, expiry cleanup, and responsive layouts; record documentation and package changes.
- [ ] Record the required user readability review and resolve its findings. Blocked on the review below.

## External Handoff

The administrator must review a synthetic fixture containing a persisted conversation, historical branch, completed task, task without an outcome, and withheld document. The review must answer:

1. Which conversation is being inspected?
2. Does it match persisted selection?
3. What task outcomes are actually recorded on this page?
4. How can related records be inspected?

Expected result: these answers are clear without opening JSON, with unavailable metadata stated explicitly. Automated assertions and agent screenshot review do not establish this result. The original handoff required the pull request to remain draft until acceptance; this cleanup does not waive that requirement or claim deployment, publication, or live-data verification.

## Completion Checklist

- [ ] Record explicit user readability acceptance and resolve or explicitly accept every material finding.
- [ ] Preserve the review outcome and verification limits in retained documentation before deleting this plan.

## Rollback / Recovery

Revert the presentation/navigation changes and rebuild the frontend. Preserve API and deep-link names. No database rollback or session reset is required.
