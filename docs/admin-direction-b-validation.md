# Direction B validation

## Outcome

All nine administration pages use the warm editorial direction B. React, Radix Themes, existing routes, API contracts, and policy precedence remain unchanged. Production screens read application data; only test fixtures contain synthetic values.

- Shared defaults has direct model and thinking controls, contextual provider setup, and compact tool and skill summaries.
- Shared surfaces provide section layouts, status labels, disclosures, and table toolbars.
- A fixed bottom bar appears only for pending edits. Saved revisions and application status remain separate.
- Policy counts include changed fields and list memberships, not grouped review entries. Restoring an unordered permission list does not leave a false pending change.
- Providers show selection and authentication before model availability. Technical checks and custom endpoints remain secondary.
- Tool permissions retain source groups and scope controls. Filters include selected, policy-blocked, pending, missing, and unavailable entries.
- Skills use compact rows with separate global and default controls. Full descriptions and chat references remain available.
- Connection tests are primary. Edit is secondary; Delete opens from an action menu and keeps its confirmation.
- Chat access uses full-width, stacked lists and a compact approval form.
- Conversation records use one chat picker and a compact identity row.
- Audit prioritizes recorded timestamp, actor, action, target, and result. Technical records remain in disclosures.

## Verified checks

Environment: Node.js 26.10.0, Chromium through Playwright.

| Check | Result |
| --- | --- |
| `npm ci` | Passed |
| `npm run format:check` | Passed |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm test` | Passed; admin has 292 tests |
| `npm run build` | Passed |
| `npm run test:browser --workspace @narumitw/sumire-admin -- --workers=8 --reporter=line` | 411 passed |
| `git diff --check` | Passed |

The browser suite covers:

- All nine pages at 1440px, 768px, 390px, and 320px widths; existing 2× CSS zoom cases also pass.
- Long chat names, technical identifiers, 200 tool entries, full skill descriptions, and long conversation records.
- Navigation, keyboard focus, dropdowns, search, filters, disclosures, and destructive confirmations.
- Unchanged, edited, discarded, saving, saved, error, and retry states.
- An exact two-field default change, retained drafts after a failed save, retry with the same payload, and unchanged explicit chat overrides.
- Separate application failures, local provider configuration, capability availability, and policy permission.
- Text and control-boundary contrast, accessible control names, input labels, and focus around fixed and sticky controls.

Fixed issues found during rendered checks include sidebar clicks interrupted by focus scrolling, CSS-zoom changes-bar bounds, low error-text contrast, and excess mobile record spacing.

## Screenshots

Screenshots show the rendered application with isolated API fixtures, not a production account. They are outside the repository and are not committed.

- Desktop overview: `/tmp/sumire-direction-b/desktop-overview.png`
- Tablet overview: `/tmp/sumire-direction-b/tablet-overview.png`
- Mobile overview: `/tmp/sumire-direction-b/mobile-overview.png`
- Pending changes: `/tmp/sumire-direction-b/shared-defaults-pending.png`
- Full-page images: `/tmp/sumire-direction-b/{desktop,tablet,mobile}/`

Each viewport folder contains `defaults.png`, `model-providers.png`, `tool-permissions.png`, `skills.png`, `mcp-connections.png`, `chats.png`, `access.png`, `conversation-records.png`, and `audit.png`. It also contains `skills-expanded.png`.

Reproduce the populated captures with `npm run test:browser --workspace @narumitw/sumire-admin -- direction-b.spec.ts`. Playwright writes them to `apps/admin/test-results/`.

## Limits

- No authenticated live deployment, real Telegram approval, provider sign-in, remote model execution, or remote MCP endpoint was tested. Browser requests were intercepted. Existing backend tests passed separately.
- Provider inventory reports local credential configuration, not remote acceptance or model entitlement.
- Tool inventory and policy permissions do not establish operational readiness. Zero discovered tools does not establish connection failure.
- Skill files must still be installed or updated on the host.
- Chat names depend on loaded metadata. Unknown names remain unknown.
- Audit has no field-level historical diffs. No replacement history was generated.
- `npm ci` reported three dependency advisories: one moderate and two high. Dependency versions were not changed in this UI task.

## Handoff

The admin package has a minor changeset at `.changeset/warm-editorial-admin.md`. No deployment or migration is included. Completed plan removed after final review: `docs/plans/2026-10-24_admin-direction-b-plan.md`.
