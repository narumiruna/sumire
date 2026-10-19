# Administration visual verification

## Baseline and decisions

- Base: `b3fdbc1`, the merged consistency work on `main`.
- Branch: `narumi/feat/admin-visual-refinement`.
- Runtime: Node.js `v26.10.0`; dependencies installed with `npm ci` (zero audit vulnerabilities).
- Typeface: Radix system stack; no font download.
- Density: 95% scaling, with 44-pixel button and selector targets.
- Surfaces: solid bordered panels; elevation only on floating layers.
- Appearance: inherit the consistency pass's explicit light mode.

The changes affect presentation only. API routes, query parameters, policy rules, save scopes, request cancellation, and draft ownership are unchanged. No runtime dependency was added.

## Checks

Final checks run from the repository root:

| Command | Result |
| --- | --- |
| `npm test --workspace @narumitw/sumire-admin` | 198 tests passed |
| `npm run test:browser --workspace @narumitw/sumire-admin` | 243 tests passed |
| `npm run format:check` | Passed |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm test` | 1,868 tests passed across nine workspaces |
| `npm run build` | Passed |
| `git diff --check` | Passed |

The browser suite verifies all eight sections at 1440, 390, and 320 pixels without horizontal page overflow. Existing contrast, save-state, security, cancellation, expiry, pagination, and draft-retention assertions remain in place. New coverage includes reduced motion, local document assets, navigation icons and titles, neutral secondary controls, ambiguous MCP status, responsive DataList pairs, named loading feedback, and copy-confirmation layout stability.

Deliberate assertion updates:

1. Chat filters now use Radix radiogroup/radio semantics, not combobox popups. Tests retain selection, filtering, keyboard, history, and draft checks. Other dropdown Escape and inactive-section cleanup checks remain unchanged.
2. Access row text no longer repeats “Revoke access”. Tests check the same per-ID accessible button names and operations separately.
3. Approval and disabled states now have separate badges. Tests check both labels and semantic tokens.
4. Panel radius checks resolve `--radius-3` in the browser instead of requiring a literal 8 pixels. All panels must still have the same border and radius.

Initial integration runs found a JavaScript chunk over 500 KB, directory geometry failures, and pending-badge overflow. These were fixed without raising the limits. React and Radix use separate production chunks; each JavaScript chunk remains below 500 KB. Static review also found and fixed a favicon path outside the production asset allowlist and an ambiguous MCP result incorrectly shown as failed. The production build test verifies that the emitted favicon exists under `/assets/*.svg`.

## Contrast

`usability.spec.ts` retains its text threshold of 4.5:1 and control-boundary threshold of 3:1.

| Measurement | Before | After |
| --- | ---: | ---: |
| Normal text | 16.39 | 16.39 |
| Muted text | 5.94 | 5.94 |
| Disabled text | 5.22 | 5.22 |
| Warning text | 14.51 | 14.51 |
| Pending text | 14.04 | 13.79 |
| Error text | 4.59 | 4.59 |
| Filter text | 16.39 | 16.39 |
| Filter boundary | 3.30 | 3.30 |
| Checkbox boundary | 3.22 | 3.22 |

Status labels remain visible with forced colors. Unit tests check the shared icon, label, and color mapping for all seven statuses. These checks support identification without color; they do not replace user review.

## Component adoption and CSS

`apps/admin/src/styles.css`: **1,153 → 1,147 lines**, a net reduction of **6 lines** after the feedback, motion, numeric, and shell rules were added.

Adopted components: DataList, Table, Link, IconButton, Tooltip, SegmentedControl, Separator, Spinner, and Skeleton. The extracted access tables live in `policy-editors.tsx`, not `main.tsx`. `providers.tsx` had no definition list at the baseline; its sign-in link now uses Link. Definition-list grid rules, access-table rules, and duplicate save-bar surface rules were removed. Remaining lists and permission rows retain their existing interactive semantics.

## Screenshots

Screenshots contain fixtures only and remain outside Git. The before set was captured from the post-consistency baseline before presentation changes. Each set contains these files:

`chats.png`, `durable.png`, `access.png`, `defaults.png`, `tool-permissions.png`, `mcp-connections.png`, `model-providers.png`, and `audit.png`.

For each width in `1440`, `390`, and `320`, the complete paths are:

- Before: `/tmp/sumire-admin-visual-design/before/visual-design-visual-evidence-at-<width>px/<section>.png`
- After: `/tmp/sumire-admin-visual-design/after/visual-design-visual-evidence-at-<width>px/<section>.png`

The final browser run also records selected-chat, pending-policy, and permission-matrix screenshots under `/tmp/sumire-admin-visual-design/after/`.

Local command evidence:

- `/tmp/sumire-admin-visual-before.json`
- `/tmp/sumire-admin-visual-after.json`
- `/tmp/sumire-admin-visual-unit.log`
- `/tmp/sumire-admin-visual-root-{format-check,lint,typecheck,test,build}.log`

Temporary paths are local handoff artifacts, not permanent PR attachments. To reproduce after screenshots:

```sh
npm run test:browser --workspace @narumitw/sumire-admin -- tests/visual-design.spec.ts --output=/tmp/sumire-admin-visual-design/after
```

## Review and limits

The complete diff was reviewed for correctness, security, lifecycle safety, compatibility, regressions, and scope. Fixtures cannot verify real device enrollment, provider authentication, or production deployment. No live service was changed.

**User screenshot review is pending.** The plan requires the user to confirm visual improvement at all three widths. Automated checks and agent review cannot satisfy that requirement. Keep `docs/plans/2026-10-20_admin-visual-design-plan.md` until that review passes; then check the review criterion and delete the completed plan.

Rollback: revert the presentation commits and rebuild the admin assets. No database, session, permission, or policy migration is required.
