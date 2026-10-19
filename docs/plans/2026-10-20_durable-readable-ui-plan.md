# Durable UI readability plan

## Goal

Make the Durable page readable without knowledge of its storage schema. An administrator must be able to identify the inspected conversation, understand its stored task outcomes and relationships, and open related records without reading JSON or entering IDs.

Readability is the primary outcome. The two confirmed navigation defects are part of this work, not the full scope. The user authorized implementation and pull request delivery on 2026-10-20; no repeated design approval is required.

## Context

- `apps/admin/src/durable-inspector.tsx` presents four object-type tabs, ID-first headings, combined metadata fields, raw numeric timestamps, and JSON details. Readers must connect the records themselves.
- `packages/contracts/src/durable-inspector.ts` provides relationship metadata, task status/outcome, timestamps, document metadata, and three approved document projections. It does not provide conversation titles, message previews, task descriptions, or message bodies.
- `docs/admin-webui.md` requires read-only inspection, separate persisted selection and inspection targets, manual refresh, bounded reads, and explicit partial failures.
- Browser review confirmed two defects: viewing historical conversation #9 then opening Tasks targets persisted conversation #7; entering a Conversation ID in Advanced inspection does not retrieve that conversation.
- The review baseline passed 73 admin unit tests and 40 focused browser tests. These tests do not prove readability and do not cover the two defects.

## Architecture

Keep the work in the admin presentation and navigation layer. Use the current API and contract. Do not change the bot, storage ownership, schema, authorization, or document allowlist.

Use one inspection target for the visible context and related navigation. Keep that target separate from the server's persisted selected conversation. Never infer persisted selection from the first row.

Build readable labels and approved-value views deterministically from structured fields. Do not use model-generated summaries, text matching, additional page scans, or automatic document-value reads.

## Reading design

The proposed page has three information levels:

1. **Context:** chat name, inspected conversation, whether it matches persisted selection, and available parent/owner relationships. Put the read-only history warning and each block's read time next to the relevant information.
2. **Readable records:** conversation relationships, task kind and stored outcome, approved document fields after explicit inspection, and entry kind/role. Use short descriptions and contextual links. Keep IDs visible as secondary identifiers; do not invent semantic titles from absent data.
3. **Technical details:** versions, internal kind names, flags, sequence numbers, direct ID controls, and raw JSON. Keep these available through progressive disclosure.

Conversation context must remain visible when the reader opens Tasks, Documents, or Entries. A relationship link must name its destination, not display only a number. Do not require readers to reopen JSON to find the next relevant record.

Task labels must describe stored observations, including nonterminal status. They must not claim current execution, scheduler health, or a successful outcome when none is stored. Missing data must remain distinct from an empty result, a withheld value, an unavailable record, and a failed read.

## Design and evidence

The approved three-level structure is implemented as an inspection-context panel, readable record list/detail views, and expandable technical fields/JSON. Persisted selection and its bounded task-history page remain in a separate, explicitly named section.

| Fixture | Primary copy | Secondary identifier or detail |
| --- | --- | --- |
| Persisted conversation | Selected conversation; this is the persisted selected conversation, not proof of running work | conversation #7 |
| Historical branch | Conversation branch; branched from conversation 6 at entry 60 | conversation #9; inspecting it does not change selection |
| Completed model task | Model response; Recorded outcome: Completed | task #8; start/end dates in UTC |
| Task without an outcome | Tool call; Recorded status: Waiting · no outcome recorded | task ID and stored kind remain available |
| Withheld document | Document; it is not approved for value inspection | document ID, family membership, and raw kind in Technical details |

Verified semantics: installed `pi-durable/dist/types.d.ts` identifies task times as wall-clock milliseconds and document lifecycle fields as commit sequences. `apps/bot/src/agent/durable/session.ts` writes entry message times with `Date.now()`. Installed `harness/registry.js` and the bot's `pi-session-factory.ts` confirm `pi.generation`, `pi.tool`, and `pi.compaction`. Legacy and unknown kinds use Task without an invented meaning.

Navigation clarification: refresh retains explicit object deep links but resets pagination and local row selection, as the existing documented pagination contract requires. A visible historical row is the next related tab's target; persisted selection is never changed.

## Non-Goals

- No transcript viewer, message previews, tool output, or new sensitive fields.
- No live task graph, execution controls, polling, or session loading.
- No full-history timeline, cross-page totals, automatic relationship traversal, or inferred chronology.
- No API changes, new packages, configuration flags, or unrelated admin redesign.

## Plan

- [x] Verify presentation semantics against the repository and installed Durable types before formatting values. Record timestamp units, document sequence-number meanings, and the built-in task kinds actually used by the bot in the implementation notes or tests. Acceptance: dates use verified units; document sequences are never formatted as dates; unknown kinds remain readable without invented meanings.
- [x] Prepare a concrete page layout and fixture-based copy examples for a persisted conversation, a historical branch, a completed task, a task without an outcome, and a document with a withheld value. Acceptance: the examples distinguish inspection from persisted selection and can be understood without JSON; obtain user agreement on the proposed reading structure before implementation.
- [x] Correct the inspection-target behavior in `apps/admin/src/durable-inspector.tsx` and its navigation tests. Acceptance: the displayed historical conversation remains the Tasks/Documents/Entries target, including a second-page row; direct Conversation ID lookup requests `objectId`; target labels, deep links, refresh, and browser back/forward agree. Persisted selection remains unchanged.
- [x] Rework the context header and record list/detail presentation in `apps/admin/src/durable-inspector.tsx` and `apps/admin/src/styles.css`. Acceptance: the inspected conversation and its known relationships are explicit; task kind, stored status/outcome, and verified dates are readable; IDs and technical fields do not dominate the first reading; related-record links name their destination. Keep directly coupled presentation logic together and extract only helpers that improve clarity or testing.
- [x] Render each existing approved document projection as labeled fields after the reader explicitly opens that document. Acceptance: model settings, numeric usage, and selected-conversation references can be read without JSON; missing numeric fields are not changed to zero; withheld and unavailable values have distinct explanations. Preserve raw JSON and copy actions as secondary tools without adding network reads.
- [x] Extend `apps/admin/src/durable-inspector.test.ts`, `apps/admin/tests/durable-fixture.ts`, and `apps/admin/tests/durable-inspector.spec.ts` for the new reading structure. Acceptance: cover known/unknown kinds, absent metadata, stored nonterminal status, all approved projections, withheld/unavailable values, partial failures, unloaded sessions, and both navigation regressions. Preserve existing security, cancellation, expiry, pagination, draft-retention, and read-budget assertions.
- [x] Verify keyboard and responsive reading at 1440, 390, and 320 pixels. Update `apps/admin/scripts/capture-durable-comparison.ts` if its heading selector changes, and capture before/after views against the same synthetic fixture. Acceptance: no horizontal page overflow; context, destination labels, focus, disclosures, and copy actions work at every width. Keep screenshots outside tracked sources.
- [x] Update the Durable section of `docs/admin-webui.md` and add a patch changeset for `@narumitw/sumire-admin`. Acceptance: documentation matches the implemented reading flow and accurately states unchanged data-access limits; the changeset describes the readability and navigation outcome.

## Verification evidence

- Final Node.js version: 26.10.0. Base: `origin/main` at `b57eac4642d2e06908844b99e8881ede6774c337`. Branch: `narumi/feat/durable-readable-ui`.
- `npm test --workspace @narumitw/sumire-admin`: 153 tests passed. The final root test run also passed these tests.
- `npm run test:browser --workspace @narumitw/sumire-admin -- --workers=4`: all 206 browser tests passed, including 47 Durable tests. No checks were skipped.
- All five required root commands passed after the final source changes: `format:check`, `lint`, `typecheck`, `test`, and `build`. Root tests passed 1,823 tests across all workspaces.
- `git diff --check` passed. The only affected package is `@narumitw/sumire-admin`; its patch changeset is `.changeset/durable-readable-ui.md`.
- Synthetic before/after overview screenshots were captured with the repository comparison script at 1440, 390, and 320 pixels. Historical conversation, tasks, model settings, usage, and session-value screenshots were also captured at all three widths. All captured views have no horizontal page overflow. Files are local, outside Git: `/tmp/sumire-durable-readable-ui-2026-10-20/`.
- Agent visual review moved advanced controls below records, collapsed duplicate selection relationships, and grouped per-model usage into disclosures. Independent code review found an additional historical-tab round-trip defect and misleading family-member withholding text; both have fixes and passing browser regressions. Record buttons now have readable accessible names and stored-observation descriptions.
- Human readability acceptance is still pending. Automated assertions and agent screenshot review do not satisfy the explicit user-review requirement. Keep the pull request in draft and retain this plan until that acceptance occurs. No production deployment, real-chat inspection, package publication, version tag, or release workflow was performed.

## Completion Checklist

- [ ] User review confirms that the default page and related-record views answer four questions without opening JSON: Which conversation am I inspecting? Does it match persisted selection? What task outcomes are actually recorded on this page? How do I inspect related records? State explicitly when metadata cannot answer a question.
- [x] Both confirmed defects have passing browser regressions, including historical selection with and without persisted selection metadata.
- [x] Readability changes preserve the existing API, bounded read sequence, explicit value inspection, cancellation, session-expiry clearing, and untrusted-text handling. Tests show no new requests from presentation or disclosure alone.
- [x] Run focused checks: `npm test --workspace @narumitw/sumire-admin` and `npm run test:browser --workspace @narumitw/sumire-admin`. Record results and any unavailable check; leave unavailable checks open.
- [x] Run repository checks from the root: `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`. Record results; leave failed or unavailable checks open.
- [x] Review the final diff, documentation, changeset, and screenshot evidence. Confirm that no secrets, private chat data, generated output, or screenshot binaries are staged. Evidence: final independent review reported no remaining concrete findings; the staged set contains only the 11 intended text files and passes `git diff --cached --check`.
- [ ] After every task and completion check passes, delete this plan and report its path with the implementation handoff.

## Rollback / Recovery

Revert the admin presentation/navigation changes and rebuild the admin assets if the new reading flow fails acceptance. No database rollback or session reset is required. Preserve the current API and deep-link parameter names so existing links remain valid.
