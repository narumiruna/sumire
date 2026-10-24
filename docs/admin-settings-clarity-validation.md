# Admin Settings Clarity Validation

Date: 2026-10-24

Baseline: `578b67d`

Environment: Node.js 26.10.0, Chromium through the admin Playwright configuration

## Result

The complete browser suite passed: **386 passed, 0 failed, 0 skipped, 0 flaky**. The 24 new acceptance cases also passed twice in succession: **48 passed, 0 skipped, 0 flaky**. The final root test run passed **2,078 tests**. All five required root checks passed.

The tests use synthetic data. The new acceptance fixture intercepts API requests and records mutation payloads. No live settings, credentials, provider discovery, or model execution were tested. Local configuration is not evidence of successful model execution.

## Baseline

Before component changes, `settings-clarity.spec.ts` ran against the previous implementation. Four new flow checks failed and the existing source-group and explicit-empty-override check passed. The failures identified the old settings caption, absent status filter, absent inline shared-model control, and absent grouped authentication summary. The new controls now pass these checks.

## Verified behavior

| Area | Evidence |
| --- | --- |
| Settings versus setup | `settings-clarity.spec.ts` and `settings-clarity-state.spec.ts` separate saved/applied settings from authentication, pending or failed application, missing inventory, and no shared model. A valid chat override remains independent of an unset shared model. |
| Saved versus draft | An unsaved model does not repair the saved setup summary. Model providers also shows the saved shared model rather than the policy draft. Missing references remain visible; no replacement is selected automatically. |
| Repair actions | Shared and chat actions carry the target provider, open Authentication, and focus its summary. Unknown providers focus provider selection. A conflicting provider preview requires confirmation; cancellation preserves it. Navigation does not write settings or start authentication. |
| Permission filters | Unit tests define inventory-presence and capability predicates separately from source and policy. Browser tests combine search and filters, verify empty results, retain hidden edits, restore expansion, and keep duplicate tool names synchronized. |
| Pending permission scope | Counts include filtered global and default edits. A tool reported by two servers counts once per scope. Default and global controls remain distinct. Named conflicts retain their links and references; filtering cannot bypass server-side validation. |
| Shared model | Selection, thinking, review, and save complete in Shared defaults. The exact revision-checked request adds only the required shared allowed-model reference. Global availability, chat overrides, access, and other policy fields remain unchanged. |
| Clear and retry | Clear-default confirmation stages only model and thinking. Cancellation makes no write. History navigation closes the dialog. Failed saves retain the exact payload for retry. Catalog changes leave unsupported thinking visible until an explicit selection. |
| Provider scope | Availability-only addition, authentication, MCP, and policy writes remain separate. Navigation does not convert an availability draft. Credential refresh retains the selection. Existing OAuth cancellation, focus, session-expiry, and dirty-policy tests pass. |
| Directory | A full 100-chat page groups 99 authentication issues for one provider and one for another. Counts describe the displayed page. Duplicate names retain ID-based accessible names; existing exact-ID search, copy, pagination, restoration, and access-state checks pass. |
| Review text | Model references are visible in review but render as text, not executable markup. Credentials and endpoint values remain outside the review. |
| Validation contract | Policy tests retain rejection behavior and verify the corrected Shared defaults destination. API fields, policy rules, database schema, and runtime behavior are unchanged. |

Unit coverage is in `default-model.test.ts`, `chat-state.test.ts`, `provider-policy.test.ts`, `save-status.test.ts`, `tool-permissions.test.ts`, and the policy workspace. Existing admin, remediation, task-centered, task-simplicity, directory, workspace, accessibility, and mixed-draft cases ran in the full browser suite.

## Layout, keyboard, and reflow

`settings-clarity-layout.spec.ts` captures the first viewport and full page for Chats, Shared defaults, Model providers, and Tool permissions at:

- 1440 × 900
- 768 × 1024
- 390 × 844
- 320 × 844

The fixture has 202 unique permission names: 100 built-in tools, 100 MCP tools, one unknown-source tool, and one stored name missing from inventory. A second server reports a duplicate tool. It also contains long model identifiers, duplicate chat names, and 100 directory entries.

Checks verify these conditions:

- Shared-model and tool-search entry controls are measured before an interaction can scroll them into view.
- Long identifiers do not cause page-level horizontal overflow. Chat names remain at least 14 px; chat state labels remain at least 13 px. Name and state contrast remains at least 4.5:1.
- A tall pending-save bar occupies at most one quarter of the viewport. Editing scope remains below it. Desktop source and column headings remain below the scope strip; narrow layouts use inline labels.
- Permission controls at the start, middle, and end of the list remain visible and keyboard-focusable in default and global editing modes. Tab and Shift+Tab preserve access without changing permissions.
- The long-list checks also pass at 200% CSS zoom using a 640 × 1688 viewport. Existing all-page zoom, reflow, focus, target-size, and directory-density cases pass in the complete suite.

At the 390 px narrow viewport, the pending scope strip ended at 320.6 px and the sampled default controls occupied 624.2–640.2 px. At 200% CSS zoom, those bounds were 641.2 px and 1249.4–1281.4 px within a 1688 px viewport. Neither sticky region covered the focused control.

## Commands and artifacts

| Command | Result |
| --- | --- |
| `npm test --workspace @narumitw/sumire-admin` | 287 passed |
| `npm test --workspace @narumitw/sumire-policy` | 8 passed |
| New browser cases with `--repeat-each=2 --workers=4` | 48 passed |
| `npm run format:check` | Passed |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm test` | 2,078 passed |
| `npm run build` | Passed |
| `CI=1 npm run test:browser --workspace @narumitw/sumire-admin -- --reporter=line,json --workers=4` | 386 passed |
| `git diff --check` | Passed |

The new browser cases are `tests/settings-clarity.spec.ts`, `tests/settings-clarity-state.spec.ts`, and `tests/settings-clarity-layout.spec.ts` in `apps/admin/`. The complete browser run also includes the existing focused regression suites specified by the implementation plan.

Generated evidence stays outside tracked sources:

- `/tmp/sumire-clarity-baseline.log`: initial failing flow checks.
- `/tmp/sumire-clarity-acceptance-final.json`: repeated acceptance results.
- `/tmp/sumire-clarity-browser-final.json`: final browser results and geometry attachments.
- `/tmp/sumire-clarity-browser-final/`: screenshots, including first-viewport and full-page captures.
- `/tmp/sumire-clarity-root-*.log`: required root checks.

These are local artifacts, not permanent repository assets. Run the commands again to regenerate them.

## Earlier failures and limits

An earlier root run and a focused bot test run failed in `native-codemode-runtime.test.ts` while waiting for synthetic process marker files. The SIGTERM case passed alone, and subsequent complete root runs passed without changes to bot code or test limits. The cause was not established. The final full root run contains no skipped tests; name-filtered diagnostic runs are not acceptance evidence.

The browser server logged negative-fixture errors and loopback proxy connection failures. The final Playwright result has no failed, retried, or skipped cases. No successful live backend or provider connection is claimed.

CSS zoom checks are not native operating-system magnification or device testing. Inventory checks cannot establish remote credential acceptance or model output. Directory summaries cover the displayed page, not every stored chat.

## Scope and recovery

Review found no API or database migration, permission-rule change, dependency addition, live-setting write, or runtime change. Patch changesets cover the admin package and the policy package's corrected validation guidance. The interface and guidance can be reverted through the normal release process. Reverting code does not undo administrator settings; restore those through the existing revision-checked settings flow.
