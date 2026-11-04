# Admin workflow redesign validation

Sections before **2026-11-05 interaction structure** record historical validation. Their frontend-only scope, measurements, and test counts do not describe the current change.

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

## 2026-11-05 interaction structure

### Outcome and boundaries

The current change replaces grouped navigation and mixed setup tasks with explicit scopes and separate operations. It retains the Sumire theme, section IDs/aliases, policy schema, revision recovery, write-only credentials, and bounded read-only conversation APIs. There is no database migration, environment-variable change, notification subsystem, automatic remote check, or second credential store.

Provider detail has Connection, Models, and Usage policy references. Shared defaults remains the shared model editor. Model-removal review lists configured/effective list, model, and thinking effects for saved explicit entries, including disabled/off-page chats and inherited fallback. Availability restoration does not restore removed selections. GitHub outbox effects and the complete inheriting-chat population are not inferred.

Chats uses the full content width; details keep a bounded reading width. The five row columns separate access from effective model and configuration diagnostics. Secrets puts its list before optional connection details. GitHub mentions opens the same connection panel and labels prior identity separately from worker health. Skills maintenance is instructions only. Conversation logs places a 300 px desktop directory beside the reader and uses a narrow selector.

MCP inventory adds optional structured memory-only observations. Untested, checking, success (including zero published names), failure, and missing/unknown results are separate. Times use Unix milliseconds; observations bind to revision and authorization epoch and are invalidated by apply/configuration changes/restart. Discovery grants no permissions. Typed HTTP/client timeout errors are distinguished without changing the existing separate initial-discovery budget.

### Baseline and artifacts

Base: `c8c6d76` on `origin/main`; Node.js 26.11.1. The earlier plan referenced `f4dafac`; the intervening base change was a package release. The initial working tree contained only the supplied uncommitted planning files.

- `npm ci` and local Playwright Chromium setup passed.
- Baseline admin unit tests: 389 passed. Baseline browser suite: 639 passed.
- Baseline first-viewport/full-page captures cover ten pages at 1440, 1024, 768, 390, and 320 px. Attachments record computed text/control geometry and read-only request traces.
- Baseline logs: `/tmp/sumire-interaction-baseline-{unit,browser,captures}.log`. Baseline artifacts: `/tmp/sumire-interaction-baseline-{browser,captures}/`.
- Current complete-suite logs: `/tmp/sumire-interaction-complete-browser-{one,two}.log`; artifacts: `/tmp/sumire-interaction-complete-browser-{one,two}/`.
- The final full-width directory capture and its direct width assertion are in `/tmp/sumire-interaction-final-fullwidth/` and `interaction-structure-layout.spec.ts`. The 99 affected layout/directory tests passed after removing the old workspace width cap.
- Capture artifacts contain synthetic fixtures only. They are local, not committed; rerun the named tests to regenerate them.

The default test port 17466 was occupied. Temporary configurations retained the tracked Playwright settings but used isolated loopback ports 17476 and 17486 for the two final shards. No existing service was stopped, and no permanent test option or environment variable was added.

### Task evidence

| Administrator task | Current acceptance evidence |
| --- | --- |
| Explain a chat's blocked tool | `interaction-directory-permissions.spec.ts`, `tool-permissions.spec.ts`, and `task-centered.spec.ts`: saved access/model diagnostics, configured/effective values, blocking sources, exact repair focus, filtered conflicts, category inheritance, no writes from inspection. |
| Connect provider, enable model, set shared default | `model-workflow.spec.ts` and `admin.spec.ts`: exact independent credential/availability/policy payloads; no catalog grant or implicit use; unchanged explicit overrides; invalid thinking/credentials/conflict and cancellation guards. |
| Remove an in-use model | `provider-policy.test.ts`, `provider-model-workflow.test.ts`, and model workflow review: disabled/off-page entries, list/thinking resets, resulting inherited model, restore limit, unknown outbox/population limits. |
| Replace a secret | `admin-secrets-github-skills.spec.ts`, `runtime-config.spec.ts`, and `github-connection.spec.ts`: list first, blank write-only replacement, keep/delete distinction, one shared authorization flow, optional-API/read failures, no code/secret storage or duplicate write. |
| Recover a failed save | `uiux-regressions.spec.ts`, recovery tests, and `usability.spec.ts`: retained drafts, explicit overlapping-choice recovery, lost replies, committed-but-failed application, refresh-only failure, isolated editor drafts, expiry and stale-session responses. |
| Read conversations without starting work | Durable history/inspector/workspace tests: explicit chat choice, unselected/unloaded/empty/failed distinctions, bounded reads, loaded-page search, role/time content, collapsed tool payloads, branch/deep-link preservation and expired-content cleanup. |
| Use narrow or enlarged layouts | `interaction-accessibility.spec.ts`, `interaction-structure-layout.spec.ts`, existing layout/contrast tests: 320–1440 px reflow, 200% CSS zoom, doubled browser font, all four chat tabs, 44 px primary controls, contrast, and full keyboard focus above the changes bar. |

The font-enlargement test uses Chromium's `Page.setFontSizes` and verifies 32 px body text. Chromium resets that override on same-document history navigation, so the test reapplies it to each page. CSS zoom is a separate geometry check. Neither establishes physical-device, screen-reader, or complete WCAG acceptance.

Independent reviews found and verified corrections for HTTP timeout classification, saved-provider reference visibility, hidden-detail editor focus, provider selection focus, and Skills dialog closure on history changes. Regression tests retain these gates. Old numeric density targets and removed selector-first/wizard assertions were replaced with measured new-layout constraints and explicit task assertions, not skipped. The production build retains the 500 kB JavaScript chunk gate by splitting policy/schema code.

### Final checks

All commands ran from the repository root against the combined implementation:

| Check | Result |
| --- | --- |
| `npm run format:check` | Passed |
| `npm run lint` | Passed; no warnings in changed workspaces |
| `npm run typecheck` | Passed |
| `npm test` | 3,238 passed across 199 test files; admin 424, bot 1,875 |
| `npm run build` | Passed; browser JavaScript chunks remain below 500 kB |
| Complete admin Playwright suite, two shards | 680 passed: 340 per shard; no retries or skipped tests |
| `git diff --check` | Passed |

For the complete browser suite, each shard used `npm exec --workspace @narumitw/sumire-admin -- playwright test --config=<temporary-config> --workers=4 --reporter=line --shard=1/2` (then `2/2`). The tracked configuration also remains usable when 17466 is free. Root logs are `/tmp/sumire-interaction-root-{format-check,lint,typecheck,test,build}.log`.

Known baseline diagnostics remain: dependency installation reports seven moderate advisories and deprecated transitive packages; root lint has an informational string-concatenation suggestion in unchanged GitHub-notifications tests. Both baseline and final browser logs contain one ResizeObserver loop diagnostic; the status-bar sizing implementation is unchanged and all bounded-height/focus gates pass. Injected malformed Audit records deliberately log their display error. These are not concealed failures or claims of production acceptance.

### External handoff and release restrictions

These items are outside local implementation acceptance. They do not authorize external writes or credential access.

| Responsible role | Prerequisite and action | Expected result and unverified behavior | Release restriction |
| --- | --- | --- | --- |
| Product/repository owner | Identify the missing Service status source/build/API, or authorize separate notification work with services, destinations, conditions, and delivery rules. | An implementable notification contract; the review's polling-service notifications do not exist in this checkout. | No placeholder link or claim that Status notifications was redesigned. A notification-inclusive release requires separate work. |
| Account administrator | After local checks, use approved accounts and explicit consent to exercise real provider/GitHub authorization and required permissions. Do not send secrets or MFA codes to the agent. | Live authorization, upstream model/repository entitlement, and reconnect behavior; local configuration and mocks do not establish these. | Do not claim live acceptance or enable new automatic replies from mock evidence alone. |
| Deployment operator | Review the matching admin/bot/contracts build and trusted-host backups; deploy only with authorization. Approve any real discovery or delivery target explicitly. | Production behavior with approved credentials and destinations; no deployment, live message, or billable model request was performed here. | Local checks do not authorize deployment, credential rotation, or external effects. |
| Design/accessibility reviewer | Review sanitized captures and, where required, physical devices or assistive technology not available to the agent. | Subjective scanability and manual/device accessibility acceptance beyond automation. | Do not claim complete usability, WCAG, or real-device acceptance. This handoff alone does not block verified agent work. |

### Recovery

Deploy or roll back matching admin, bot, and contracts builds together. Missing observation fields render Unknown without parsing legacy prose. This change needs no database restore or migration. A display rollback does not undo committed policy, removed model references, replaced credentials, OAuth authorization, or external actions; use explicit reviewed repair operations. Preserve the existing database/key backup procedure and do not abort agent work or reset sessions merely to revert presentation. No packages, version tags, release workflows, or production deployment were created by this work.
