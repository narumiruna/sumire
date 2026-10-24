# Admin workflow redesign validation

## Scope and transaction contract

This change is frontend-only. API schemas, authorization, durable reads, and policy inheritance remain unchanged.

| Action | Request | Save scope and draft owner | Destination |
| --- | --- | --- | --- |
| API key | POST providers/:provider/credential | Provider credential; Providers owns input | Selected provider/model retained |
| OAuth | POST providers/:provider/oauth; GET/POST oauth/:id | Provider credential; Providers owns login and cancellation | Selected provider/model retained |
| Enable model | PUT settings with revision | Global model availability only; Providers owns preview | Choose use for the same model |
| Choose shared default | PUT settings through policy review | Model, thinking, shared allowed list; App owns policy draft | Shared defaults editor |
| Choose chat override | PUT settings through policy review | Selected chat model, thinking, allowed list; App owns policy draft | Originating chat editor |
| Inherit shared model | PUT settings through policy review | Selected chat model, thinking, allowed-list inheritance; App owns policy draft | Originating chat editor |
| Tool permissions | PUT settings through policy review | Global/default/chat policy fields; App owns policy draft | Current permissions scope |
| MCP connection | PUT mcp/:name | Connection draft; MCP editor owns input | Connection editor |

Credentials, model availability, policy edits, and MCP changes are separate transactions. Cancelling a later step does not undo an earlier save. Authentication refresh must not replace unrelated policy drafts. Final model use includes any other staged policy changes in the existing review.

## Navigation contract

Stable route IDs and aliases are retained.

| Group | Page IDs |
| --- | --- |
| Chats | Chats, Access, Durable |
| Models | Model Providers |
| Tools & skills | Tool permissions, Skills, MCP connections |
| Defaults | Defaults |
| Activity | Audit |

## Baseline

Base: `ee39907`, before production edits. `workflow-layout.spec.ts` uses `adminFixture` for configured/setup-required chat states, provider setup and tool permissions, and `durableFixture` for populated records. Every API request is intercepted. Screenshots are generated in ignored Playwright output; baseline copies were retained outside the repository for comparison.

| Viewport | Setup-required tab bottom | Configured tab bottom | Provider page height | Permissions page height |
| --- | ---: | ---: | ---: | ---: |
| 1440×900 | 501.8 | 374.2 | 1324 | 1204 |
| 768×1024 | 589.8 | 462.2 | 1595 | 1302 |
| 390×844 | 607.2 | 515.6 | 1709 | 1347 |
| 320×844 | 647.2 | 551.6 | 1777 | 1436 |
| 640×900, 2× CSS zoom | 1294.4 | 1103.2 | 3552 | 2873 |

Measurements are browser CSS-coordinate output, including the zoom multiplier. Target desktop heights are at most 1059px for providers and 963px for permissions. Mobile tabs must end by 450px at 390×844 in the specified fixtures.

## Delivered measurements

| Viewport | Setup-required tab bottom | Configured tab bottom | Provider page height | Permissions page height |
| --- | ---: | ---: | ---: | ---: |
| 1440×900 | 457.8 | 362.2 | 987 | 951 |
| 768×1024 | 430.2 | 370.2 | 1482 | 1112 |
| 390×844 | 447.6 | 387.6 | 1672 | 1241 |
| 320×844 | 487.6 | 423.6 | 1787 | 1330 |
| 640×900, 2× CSS zoom | 975.2 | 847.2 | 3572 | 2661 |

Desktop provider height decreased by 25.5%; permission height decreased by 21.0%. The inventory, permission rows, and open authentication disclosure match the baseline. Model setup adds explicit steps and a use action; no primary control was removed to meet the density target. At 320px the provider page is 10px taller because the additional setup guidance wraps. The plan's density target applies to desktop; narrow layouts retain their controls and reflow without horizontal page overflow.

At 390px, both chat states meet the 450px tab-bottom target and show the first Overview action without scrolling. Screenshots were reviewed for the provider desktop page and mobile chat details. The full browser suite also checks contrast, control sizes, keyboard focus, directory pagination, long names, multiple readiness issues, and zoom reflow.

## Requirement evidence

| Requirement | Evidence |
| --- | --- |
| Continuous model setup and exact save scopes | `model-workflow.spec.ts`: API key → availability → shared use; originating-chat override and inheritance; exact policy/write assertions |
| Completed-step cancellation and preserved previews | Model workflow cancellation before/after staging, OAuth cancellation, Back navigation, and origin-model repair tests |
| Plausible failures | Model workflow conflict, persisted-but-failed application, missing provider/model, unsupported thinking, expiry, and unrelated-draft tests; existing provider OAuth and credential failure tests remain passing |
| Inheritance and stored selections | `model-use.test.ts`: scoped field changes, disabled chat preservation, explicit empty selections, unavailable stored references, invalid IDs |
| Mobile layout and actions | `workflow-layout.spec.ts` bounding boxes; `workflow-state.spec.ts` menu keyboard, focus return, copy, record navigation; `chat-workspace.spec.ts` long names and directory scroll restoration |
| One record refresh | Workflow state test asserts only durable API reads, no global Reload, preserved policy draft, retry, and expiry |
| Expanded content and selection lifecycle | `durable-content.spec.ts` and `durable-inspector.spec.ts`: refreshed content, selected records, partial history failures, independent read times, bounded reads, and expired sessions |
| Density and difficult states | Workflow layout fixtures at all five sizes; workflow state screenshots for 152 tools, long labels, mixed drafts, loading, empty inventory, and retryable errors |
| Stable navigation | `navigation.test.ts` stable IDs and aliases; existing navigation/repair tests and model workflow Back/return focus checks |

Generated screenshots remain in ignored `apps/admin/test-results/`. Rerun the browser tests to regenerate them. No images, credentials, runtime state, or dependency changes are included in the commit.

## Final checks

Node.js 26.10.0; commands run from the repository root:

- `npm ci`: passed; reported three existing dependency advisories (one moderate, two high). Dependency remediation is outside this frontend change.
- `npm run test:browser --workspace @narumitw/sumire-admin -- --workers=4`: **430 passed**.
- `npm run format:check`: passed.
- `npm run lint`: passed without warnings in the affected workspace.
- `npm run typecheck`: passed.
- `npm test`: **2,096 tests passed across 154 suites**, including 297 admin unit tests.
- `npm run build`: passed.
- `git diff --check`: passed.

Initial browser failures included old selectors for moved readiness details, mobile actions, and the removed global Reload. These assertions now test the new destinations without removing their behavioral checks. New fixture timing and selector errors were corrected. An initial lint failure for the model-use label was corrected with an explicit control association; non-null assertions and CSS specificity warnings were also removed. Final checks above passed after these corrections.

## Review and release limits

- Correctness: final model use only stages the selected scope; the existing settings review owns writes. Existing disabled-chat state and unrelated stored selections are retained.
- Security: no new endpoint, credential storage, remote call, raw HTML rendering, or permission bypass. Secrets are not placed in setup URLs or review text.
- Lifecycle: model-use dialogs close on section changes and remount on model/chat changes. The mobile chat menu closes on browser Back/Forward section changes and does not restore focus to a hidden trigger; a dedicated regression test verifies this. Existing OAuth polling cleanup, cancellation, session expiry, and revision conflicts remain in effect.
- Compatibility: page IDs, URL fields, aliases, policy schema, and backend API contracts are unchanged. Conversation-record refresh remains bounded and read-only.
- Scope: only admin source/tests, documentation, and an admin minor changeset are changed. The completed implementation plan is removed; this document retains its evidence.
- Tests use mocked provider and Telegram responses. Real external OAuth, live provider acceptance, and production deployment were not exercised. Local configuration is not a claim of successful model execution.
- Rollback: deploy the preceding matching application build. This change needs no database restore or migration. Do not publish packages or dispatch release workflows as part of this PR.
