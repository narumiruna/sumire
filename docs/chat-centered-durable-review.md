# Chat-centered Durable review ledger

Target: [PR #148](https://github.com/narumiruna/sumire/pull/148).

Repository and branch match: `narumiruna/sumire`, `narumi/feat/chat-centered-durable`. The PR is open. The reviewed head is `6057306`; source changes since the earlier complete diff review are limited to CI screenshot capture. Repository instructions are unchanged. All REST feedback pages and all GraphQL thread/comment pages were read; no next page remained.

| Item | Evidence and scope | Severity | Outcome |
| --- | --- | --- | --- |
| [Historical conversation changes when switching tabs](https://github.com/narumiruna/sumire/pull/148#discussion_r4315635702) | `durable-inspector.tsx` derives `inspectedConversation` from conversation `objectId`, but tab navigation instead uses `location.conversationId ?? selected?.id`. A parent link has `view=conversations&objectId=6`; persisted selection 7 replaces target 6 on the next tab. Without a persisted selection, Documents can fall back to session scope. This is a PR navigation regression and conflicts with preserved deep links and separate persisted selection. | P2: incorrect inspection context; no execution or state mutation. | Already addressed. Tab context now uses `inspectedConversation` before the persisted fallback, including document scope. Six browser regressions cover Tasks, Documents, and Entries, with and without persisted selection. |
| Review receipt and summary | The submitted review and conversation summary refer to the same finding above. Neither contains another technical request. | Informational | No separate code action. The technical outcome will be published on the linked thread. |

## Validation and publication

The new Tasks regression failed before the patch: expected `view=tasks&conversationId=6`, received `view=tasks&conversationId=7`. After the patch, all 23 focused Durable browser tests passed, including the six new cases. All required root checks passed: formatting, lint, typecheck, 1,736 tests, and build. The full browser suite passed all 182 tests. No test limit or assertion was relaxed.

The fix is published under `fix(admin): preserve inspected conversation across tabs`. The linked review thread records the fix commit and platform resolution. There are no deferred items or clarification requests.

Remote CI status must be checked separately; an in-progress check is not a successful check. See [validation](chat-centered-durable-validation.md) for the earlier test evidence and known limits.
