# Administration Task Simplification Validation

## Scope and limits

Validated on 2026-10-24 with Node.js 26.10.0 and Playwright 1.64.1 Chromium. This follow-up addresses the six task-flow findings after the [earlier UI/UX remediation](admin-uiux-remediation-validation.md).

All browser APIs use synthetic fixtures. These checks do not contact Telegram, authenticate real providers, or change a running bot. They measure behavior, focus, layout, and request payloads, not user comprehension or production task-completion time. API contracts, runtime permissions, dependencies, and database schemas are unchanged.

## Task evidence

The initial 10 task-acceptance cases failed before implementation. The final browser suite passed 362 tests with no skipped, flaky, or unexpected results. `task-simplicity.spec.ts` and `task-simplicity-state.spec.ts` add 22 cases. The 22 cases also passed two consecutive runs. After fixing a fixture navigation race, the source-search cases passed 15 consecutive runs at both reference widths.

| Review area | Result and verification |
| --- | --- |
| Shared model | Provider/model selection and the task save action precede credential maintenance. Configured credentials start collapsed. Default intent survives authentication, navigation, cancellation, and failed-save retry. Credential refresh keeps the authentication disclosure open and restores keyboard focus. Availability-only saves retain their separate behavior. |
| Chat approval | One signed-ID form precedes both lists, including with 100 approved users. Each list has at most 20 rows per page. Search finds entries outside the current page. Invalid, duplicate, fractional, zero, and unsafe-integer IDs cannot stage approval. |
| Save review | Review approval stages one ID and opens the shared review without a request. One review contains all policy changes and editor links. Cancellation and failed saves retain the draft. Tests verify exact revision-checked payloads, revocation warnings, and unfinished-input guards. |
| MCP creation | Basic HTTP fields and Save connection fit the mobile viewport. The saved list is hidden during editing. Field-operation review, secrets, and JSON stay secondary. Exact retry payloads, close/resume focus, transport handling, redaction, deletion, and secret preservation remain covered. |
| Tool permissions | Search finds a tool among 40 names. Default permissions appear first; global controls require an explicit action. Source search opens matching groups without changing saved expansion. Search retains draft selections, capability diagnostics, and server restrictions without a write. |
| Chat details | Normal status is compact and does not claim remote verification. Model and tool actions fit the mobile viewport. Blocked states retain their repair actions; readiness details and overrides remain available. |

Existing tests now open the relevant task, disclosure, or global controls through the visible UI. Mutation, permission, revision, cancellation, and recovery assertions remain. Mixed-draft tests prove that saving approval does not save connection or model drafts. Unfinished endpoint input blocks confirmation and has a focused return action.

## Reference geometry

These are viewport coordinates from the final browser report, rounded to the nearest pixel. Measurements occur before clicking or filling the measured control, so Playwright cannot hide an off-screen entry point through automatic scrolling. Connection measurements follow Add connection and explicit transport selection. Chat measurements follow selection of a configured chat.

| Control | 390 × 844 | 1440 × 900 |
| --- | --- | --- |
| Shared-default Model control | 335–379 px | 325–369 px |
| Save default model | 541–585 px | 487–531 px |
| Approval input with 100 users | 231–273 px | 216–258 px |
| Review approval | 230–274 px | 215–259 px |
| HTTP connection URL | 524–566 px | 543–585 px |
| Save connection | 753–797 px | 716–760 px |
| Tool/source search with 40 tools | 381–423 px | 324–366 px |
| Matched default-permission indicator | 576–592 px | 538–554 px |
| Chat Change model action | 676–720 px | 445–489 px |
| Chat View tool permissions action | 792–836 px | 506–550 px |

The permission coordinates describe the checkbox indicator; its labelled row remains the interaction target. Existing button/select checks retain the 44 px minimum. Screenshots cover all nine pages at 1440, 768, 390, and 320 px. Keyboard and overflow checks include 320 px and 200% CSS zoom. Task screenshots show the first viewport, not only full-page output.

## Checks

| Command | Result |
| --- | --- |
| `npm run format:check` | Passed |
| `npm run lint` | Passed without lint warnings |
| `npm run typecheck` | Passed |
| `npm test` | 2,072 tests passed in 152 files; admin: 281 tests in 23 files |
| `npm run build` | Passed |
| `CI=1 npm run test:browser --workspace @narumitw/sumire-admin -- --reporter=line,json --workers=4` | 362 passed; zero skipped or flaky tests |
| `PATH="$PWD/node_modules/.bin:$PATH" sh scripts/pre-commit.sh` | Passed before the required root checks |
| `git diff --check` | Passed |

The admin SSR tests emit Node.js's non-failing localStorage experimental warning. No required check was unavailable.

Local evidence is in `/tmp/sumire-task-final/`, `/tmp/sumire-task-final.json`, and `/tmp/sumire-task-root-*.log`. `/tmp/sumire-task-baseline.log` records the original failures. Repeated-run logs are `/tmp/sumire-task-guards-final.log` and `/tmp/sumire-task-search-repeat.log`. These temporary artifacts and screenshots are not committed or required by the repository.

The change includes only admin sources/tests, documentation, and an admin patch changeset. It requires no data migration. Production device enrollment, provider acceptance, and real service behavior remain separate administrator checks.
