# PR #217 Review Ledger

## Review Scope

- Repository: `narumiruna/sumire`.
- Pull request: https://github.com/narumiruna/sumire/pull/217.
- Reviewed commit: `fec412943c1ddc373a83d8049e7e0945c31aa6e6`.
- Goal: match the conversation-records reference and retain usable History controls.
- Read the description, commit, complete diff, checks, submitted review, inline comment, conversation summary, and review thread. All feedback pages were fetched. The thread has one comment and no further pages.
- The review receipt and conversation summary contain no separate action beyond item R1.

## R1 — Desktop Entry Navigation Loses Keyboard Focus

- Source: https://github.com/narumiruna/sumire/pull/217#discussion_r4424363719.
- Thread: `PRRT_kwDOUibsLc6x_eU9`.
- Severity: P2. Adjacent entries remain available, but keyboard navigation stops after each change.
- Scope: in scope. PR #217 adds Previous/Next controls and moves them into the selected record header.
- Evidence: `activeDetail` becomes undefined when `selectedId` changes. The controls then move from the keyed detail section to the loading branch. They move back after the detail read. The selected section also has an entry-specific React key. These changes remove the focused button. The existing navigation test uses pointer clicks and checks entry IDs, not focus.
- Outcome: already addressed. The focused fix and regression tests are in this revision. The linked GitHub thread records the published commit and platform resolution.
- Reproduction: two delayed-read keyboard tests fail at `fec4129`. Both Previous and Next lose focus. A separate in-memory check of that commit confirms that another Enter does not select the next entry. The test that moves focus to search passes before the fix.
- Local fix: restore the focused desktop navigation control during loading and after the matching read. Cancel this intent when focus leaves navigation, details close, the selected entry changes, or the viewport changes. Use an enabled adjacent control at a page boundary. Keep the layout and mobile dialog behavior unchanged.
- Focused validation: all 34 History browser tests pass, including seven new keyboard, boundary, focus-movement, and mobile tests.
- Full local validation: all 639 browser tests pass. The required root checks pass. No CSS, record rendering contract, API, or mobile focus callback change is needed for R1.

## R2 — GitHub Runner Image Notice

- Source: container check annotation at https://github.com/narumiruna/sumire/actions/runs/41066861099/job/124100424500.
- Evidence: the successful container check has a notice that `ubuntu-latest` will move to Ubuntu 26. PR #217 does not change `.github/workflows/ci.yml`, which already uses this runner label. The annotation reports no application failure.
- Severity: informational. No P0 incident or product defect is shown.
- Scope: out of scope. The runner policy is separate from the administration UI change.
- Outcome: valid but out of scope — deferred. If runner compatibility needs action, use a separate CI maintenance issue or pull request. Do not change the runner policy in this UI fix.

## R3 — Chat Directory Density Regression

- Source: failed `typescript` check, `tests/task-centered.spec.ts:418`, at https://github.com/narumiruna/sumire/actions/runs/41066861099/job/124100423424.
- Severity: P3. The directory needs extra scrolling; no data or access control is lost.
- Scope: in scope. PR #217 adds a breadcrumb row and a larger shared heading above the existing chat directory.
- Evidence: the unchanged 1440 × 900 test requires six complete rows but finds five. An independent local run gives the same result. The added shared header space reduces the part of the directory inside the viewport.
- Local fix: keep the reference header on Conversation records. Other pages use the compact heading and place account actions inside their header.
- Focused validation: the unchanged density test now shows six complete rows at 1440 × 900. The directory starts at 205.59375 pixels instead of 282.296875 pixels.
- Outcome: already addressed. The full browser suite passes with the existing density limit.

## R4 — Model Providers Page Height Regression

- Source: failed `typescript` check, `tests/workflow-layout.spec.ts:85`, at https://github.com/narumiruna/sumire/actions/runs/41066861099/job/124100423424.
- Severity: P3. Extra header space increases scrolling; no provider function is lost.
- Scope: in scope. The same new shared header increases the height of a settings page outside the reference workspace.
- Evidence: the unchanged 1440-pixel layout test allows at most 1059 pixels. CI and an independent local run both report 1103 pixels. The PR adds the breadcrumb row and changes the shared heading from 28 to 34 pixels.
- Local fix: use a compact header outside Conversation records. Keep the reference workspace and test limits unchanged.
- Focused validation: Model providers is now 1026 pixels high, below the 1059-pixel limit. Tool permissions is 935 pixels high, below its 963-pixel limit. The unchanged workflow test passes.
- Outcome: already addressed. The full browser suite passes with the existing height limits.

## R5 — Refresh Test Uses an Incomplete History Read as Its Ready State

- Source: the full local browser suite, `tests/workflow-state.spec.ts:175`.
- Severity: P3. This is a test race, not a session-expiry defect.
- Scope: in scope as validation of the changed record controls. The PR must retain the bounded History loading and expiry flow from #216.
- Evidence: after returning to Durable, the view is History. The old test treats an enabled Refresh button as completed recovery, then expires all fixture requests. A pending History read can then return 401 before the next button click. The application correctly clears the session, and the test fails because its button no longer exists. Five local repetitions reproduce this sequence. No application authentication change is needed.
- Local fix: wait for a loaded History entry before expiring the fixture. Keep the expiry click and content-clearing assertions unchanged.
- Focused validation: five consecutive repetitions pass after adding the positive ready-state check.
- Outcome: outdated or superseded. The test now waits for loaded History content. No application authentication change was adopted. All 639 browser tests pass with this ready-state check.

## Check State at Review Start

- `container`: passed.
- `typescript`: running its administration browser tests. Formatting, lint, typecheck, unit tests, and build have passed in that job.
- The browser step later failed on R3 and R4. The other 630 browser tests passed. Formatting, lint, typecheck, unit tests, and build passed in that job.
- The new commit checks and thread state will be refreshed after publication.

## Local Validation

- All 639 administration browser tests pass with eight workers and synthetic API fixtures. This includes the seven new focus tests.
- All required root checks pass: `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
- `git diff --check` passes. No images or generated files are part of the fix.
- No review item needs clarification. No external condition blocks publication. The runner-image notice remains a separate maintenance item.
