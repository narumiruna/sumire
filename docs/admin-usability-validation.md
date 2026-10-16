# Administration usability validation

## Scope and baseline

Validation uses isolated browser API fixtures and temporary backend state. It does not use production settings, credentials, Telegram requests, or model generation.

The pre-change Chromium suite passed 103 tests. The initial inspection and baseline tests confirmed these remaining issues:

| Section | Source | Baseline finding and delivered change |
| --- | --- | --- |
| Chats | `apps/admin/src/chats.tsx`, `styles.css` | Directory used “Allowed” and repeated unnamed labels. Setup blockers already existed. Approval now has a neutral badge; details separate approval, enabled state, configuration, verification, and application. Fallback names include IDs. The directory has one viewport-bounded scroll area on desktop. |
| Access | `apps/admin/src/main.tsx`, `tests/access.spec.ts` | Search already covered the whole policy list, but names were loaded-page metadata and rows were tall. Labeled tables now include matching/draft/saved/revocation counts and pending-change links. |
| Defaults | `main.tsx`, `tests/tool-permissions.spec.ts` | Tool defaults already had a canonical destination. Saved/draft summaries now include model, thinking, and allowed models; reset has a visible disabled-state explanation. Checkbox names are explicit. |
| Tool permissions | `tool-permissions.tsx` | Existing global/default controls already retained removed selections and showed conflicts. Four columns now expose the effective inherited result and named MCP server gates. Detailed rules are expandable. |
| MCP connections | `main.tsx`, `mcp-editor.tsx`, backend `admin/mcp.ts` | Updates were advanced JSON patches. Guided fields now precede JSON and share the same draft. Preview operations use field names only and include transport cleanup. Saved connection values remain hidden. |
| Model providers | `providers.tsx` | Credentials and model saves were already separate. Numbered steps now expose check status and explicit model saving. Local checks cannot establish remote verification. Check results apply only to the checked provider and revision. Checkbox and combobox names are explicit. |
| Audit | `activity.tsx`, `audit.tsx`, backend `store.ts` and `server.ts` | Audit had readable operation names but only offset pagination. Exact server-side filters now cover all retained records, with inclusive UTC date bounds. Adjacent revision/target groups retain individual events and expose failures. Audit queries no longer reload policy drafts. |

## Save-state contract

| State | Visible result and permitted action | Draft handling |
| --- | --- | --- |
| Clean | Saved application status and per-scope “No browser edits” links | No save action for an unchanged policy |
| Dirty | Policy count/review/apply/discard; separate MCP/provider notices | Navigation retains each scope |
| Unstaged input | Finish or clear the named editor; shared saves unavailable | Not silently included in policy |
| Saving/checking | Progress announcement; configuration controls unavailable | Existing draft stays until the request and refresh succeed |
| Saved, application pending | Pending application status, saved/applied revision details | Not reported as Applied |
| Failed application | Failed status and retry after conflicting local input is resolved | Reload can inspect committed state without clearing MCP/provider previews |
| Revision conflict | Error and retained input | No automatic overwrite or retry with a new revision |
| Expired session | Sign-in replaces editors | Sensitive drafts and cached chat metadata are cleared |
| Multiple drafts | Separate scope statuses and explicit save actions | Policy save/discard does not save/discard MCP or provider previews |

`providers/:id/test` checks local credential availability only. Explicit custom model discovery performs a bounded remote model-list request; a successful result is labeled as that check only. No model-execution verification was added. Audit storage contains actor, time, operation, revision, outcome, and target, not historical field diffs. Summaries do not infer missing diffs or events on another page. The filter API and MCP inventory field-name list are additive; neither changes the database schema.

## Acceptance evidence

- `apps/admin/tests/admin.spec.ts`: existing mutation, conflict, application failure, cancellation, missing/disabled provider, inherited/empty list, pagination, navigation, deep-link, draft retention, and session-expiry cases remain in the suite. Assertions changed only for the delivered UI contract.
- `apps/admin/tests/usability.spec.ts`: clean, policy-only, MCP-only, provider-only, and mixed drafts across all seven sections; guided/JSON round-trip and masked preview; server-query filters without draft loss; failed and stale query isolation; visible failed audit retries; provider check failure/configuration versus remote verification; accessible names, keyboard focus, reflow, and contrast.
- `apps/admin/src/mcp-editor.test.ts`, `audit.test.ts`, `navigation.test.ts`: deterministic map replacement/preservation/removal, transport cleanup, malformed input, bounded date encoding, grouping boundaries, and old/new provider deep links.
- `apps/bot/tests/admin-server.test.ts`: authenticated filter queries, exact combined predicates, inclusive date boundaries, equal-time stable ID ordering, page bounds, empty results, SQL injection input, duplicates, malformed dates, and unauthenticated rejection.
- `apps/bot/tests/admin-mcp.test.ts`: omitted-field preservation, null preservation, literal replacement, map clearing, unknown fields, stale revisions, transport cleanup, and inventory/audit secret redaction.

Reflow and focus checks run at 1440 and 320 CSS pixels, plus 200% CSS zoom at a 640-pixel viewport. This is Chromium layout/keyboard evidence, not real-device browser zoom or a screen-reader certification. Existing narrow-layout tests also run at 390 pixels. The persistent bar is bounded and its measured height supplies the content scroll offset. Status changes use existing polite status announcements and do not move focus.

Measured contrast uses computed colors composited over actual ancestor backgrounds. The automated test attaches its current measurements to the Playwright result. Representative passing measurements are:

| State | Text ratio | Required |
| --- | --- | --- |
| Normal heading | Greater than 15:1 | 4.5:1 (also exceeds large-text 3:1) |
| Muted metadata | 5.94:1 | 4.5:1 |
| Disabled reset action | 5.22:1 | 4.5:1 (stricter than the disabled-control exemption) |
| Pending badge | 14.04:1 | 4.5:1 |
| Tool warning | 14.51:1 | 4.5:1 |
| Unchecked permission-checkbox border | 3.30:1 | 3:1 |
| Error message | 4.59:1 | 4.5:1 |
| Directory filter text | 15.98:1 | 4.5:1 |
| Directory filter boundary | 3.22:1 | 3:1 |

The original pending badge measured 3.86:1 and failed. Its foreground was corrected. Status also has text, not color alone. These are affected-component checks, not a claim that every application color combination has been audited.

## Final command results

All checks passed on Node.js 26.10.0:

- Root `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
- Root tests: 1,418 passing tests across all six workspaces (44 admin, 1,009 bot, 9 login, 7 progress, 298 URL content, and 51 URL tool).
- `npm run test:browser --workspace @narumitw/sumire-admin`: 113 passing Chromium tests.
- `node apps/bot/scripts/check-admin-local.mjs`: real local HTTP virtual-authenticator, cookie, CSRF, logout, reload, and approval checks passed. The obsolete Access-button selector was updated to the current navigation link.
- `node apps/bot/scripts/check-admin.mjs`: offline HTTPS assets, authentication, CSRF, logout, and restart-persistence smoke passed.
- `git diff --check`: passed. Generated screenshots and temporary state are not committed.

## Review and remaining external checks

- Authorization, global ceilings, separate secret stores, runtime application, and cancellation logic remain unchanged.
- Audit SQL uses fixed column names and parameter-bound values. Results remain bounded to 100 rows over at most 10,000 retained records. Live inserts can shift existing offset pages; grouping is page-local and explicitly labeled.
- MCP previews never render patch values. Guided updates preserve unedited JSON fields. Saved commands and URLs remain opaque. Connection tests still require an explicit action and can start administrator-supplied stdio code.
- The save bar uses a cleaned-up `ResizeObserver`; audit queries ignore late results after query changes or unmount. Provider checks are revision-scoped.
- No database migration, dependency update, package publication, tag, or release workflow is part of this change. `npm ci` reported an existing critical transitive `handlebars` advisory; dependency remediation is outside this UI/API change.
- Real-device Passkey use, screen-reader output, live provider acceptance, and production deployment remain unverified. They are not replaced by fixture results.
- User acceptance of the delivered redesign remains open. Keep `docs/plans/2026-10-16_admin-usability-plan.md` until that acceptance is recorded. Deployment rollback uses the previous compatible image; do not restore an old access-policy snapshot for a visual rollback.
