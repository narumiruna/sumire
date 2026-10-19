# Pi Durable Inspector validation

## Result

The read-only Inspector is implemented for already loaded chat sessions. It exposes metadata for Conversations, Tasks, Documents, and Entries, plus three approved singleton document projections. It adds no storage migration, session-opening path, or model/tool loop.

Base: `969f9ee` on `main`. Implementation branch: `narumi/feat/pi-durable-inspector`.

## Read and ownership evidence

- The factory captures only bound public Storage read methods. The reader receives no commit, ID allocation, close, execution, or filesystem-opening capability.
- Registry inspection does not call session creation. Unloaded and in-flight-creation cases return `not-loaded` without another owner.
- One read lease per chat survives cancellation until the underlying read settles. Reset, recovery eviction, policy invalidation, and shutdown invalidate results and drain the lease before closing the owner.
- Real Pi fixtures prove no new durable commits, model requests, MCP starts, tool effects, or Telegram deliveries during inspection. Baselines include pending outbox work, existing messages/documents, and positive execution/discovery counters from setup.
- Public contract tests cover fork-visible entries, historical/completed tasks, session/conversation/task scopes, family metadata, unknown kinds, retired documents, query/chat/owner-bound cursors, payload limits, and sanitized failures.
- Document detail performs at most two approved-kind metadata lookups before materializing one known singleton. Unknown kinds, family keys, and task document values are not materialized for display.

Native limitations are explicit: public Storage scans materialize complete task/entry records, and an approved document read materializes its complete stored value. Projection/response bounds do not bound native allocation. Cancellation cannot interrupt synchronous SQLite or JSON work. No timeout releases an unresolved native read or closes its owner early.

## Security and review dispositions

- Authentication is checked before the read and again before delivery. Expiry, revocation, disconnect, request deadline, owner changes, and shutdown discard results.
- Scope validation occurs inside the selected chat's captured reader. Tests use overlapping numeric IDs, foreign scopes, modified cursors, and secret/effect sentinels.
- DTO projection excludes inputs, checkpoint payloads, memos, message bodies, tool output, instructions, outbox values, provider session identity, trust keys, and family keys.
- Review found metadata object spreads and unchecked primitive/enum values. Explicit field selection and runtime scalar validation now reject nested payloads; regression tests pass.
- Review found that links for withheld documents could mislabel them as retired. Only inspectable metadata-only rows offer value lookup. Browser fixtures now match approved versions/scopes and assert that withheld metadata expansion makes no value request.
- Frontend reads use cancellation and request identity checks. Old chat/object responses cannot replace the new view, expired sessions clear data, and untrusted strings remain text rather than HTML or fetched URLs.
- Full diff review covered correctness, security, lifecycle safety, compatibility, regressions, and scope. Existing policy drafts, discard confirmation, access controls, and transport recovery remain in place.

## Verification

Environment: Node.js 26.10.0, npm 11.19.1.

| Command | Result |
| --- | --- |
| Serial `npm ci` | Passed; zero vulnerabilities. Existing transitive deprecations: `whatwg-encoding`, `node-domexception`. No dependency installation overlapped tests. |
| `npm run format:check` | Passed. |
| `npm run lint` | Passed without warnings. |
| `npm run typecheck` | Passed. |
| `npm test` | Passed: 129 files, 1,703 tests. Bot: 86 files / 1,158 tests; admin: 11 files / 56 tests. |
| `npm run build` | Passed. |
| Focused bot Inspector tests | Passed: 29 tests across public-read contracts/projections, real HTTP, and lifecycle races. |
| `npm run test:browser --workspace @narumitw/sumire-admin -- tests/durable-inspector.spec.ts --workers=1` | Passed: 12 tests, including 1440/390/320 px layouts, keyboard, approved JSON, all views, scope, pagination, refresh, expiry, delayed reads and draft retention. |
| `npm run test:browser --workspace @narumitw/sumire-admin -- --workers=1` | Passed: all 152 browser tests. Assertions and timeouts were not weakened. |
| `node apps/bot/scripts/check-admin.mjs` | Passed: offline HTTPS administration, assets, sessions, CSRF, logout and restart persistence. |
| `node apps/bot/scripts/check-admin-local.mjs` | Passed: real local HTTP and Chromium virtual-authenticator registration/sign-in, Secure cookies, CSRF, logout and explicit chat approval after reload. |
| `git diff --check` | Passed. |

Initial parallel browser runs had intermittent failures in existing MCP save/delete and chat-retry scenarios; they are not counted as passing evidence. An initial run passed 147/150 tests, and its three failing scenarios passed isolated reruns. After completing all 12 Inspector scenarios, the final full suite passed 152/152 with one worker. No browser configuration, assertion, or timeout was changed to obtain that result.

Browser interaction tests use the real frontend with API fixtures. Backend tests separately use the real HTTP server, session registry, Pi Harness, and disposable SQLite storage. These checks do not claim live Telegram, real provider acceptance, production deployment, or a new OS credential-isolation boundary.

## Handoff and rollback

Operator behavior, endpoints, limits, units, error states, and rollback are documented in `docs/admin-webui.md` under **Durable Inspector**. The feature requires no database conversion; roll back the matching bot/admin/contracts build together after reads drain. Do not abort agent work or restore an old database snapshot for a display-only rollback.

The changeset bumps `@narumitw/sumire`, `@narumitw/sumire-admin`, and `@narumitw/sumire-contracts`. No package publication, Git version tags, deployment, or release workflow dispatch is part of this work. No runtime databases, credentials, generated output, or unrelated staged work belong in the implementation commit.
