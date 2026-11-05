# Shared administration design

Extends the approved chat-management design and the three follow-up concepts to
all ten administration destinations. Interface text supports English, Traditional
Chinese, and Japanese. URL identifiers and policy values remain stable; labels
and accessible names follow the selected language. External data stays literal.
See [interface language selection](../admin-webui.md#interface-language).

## Shared presentation

- Off-white `#fafaf9`, forest-green `#24553e`, neutral borders, white 12px cards.
- 30px page headings (28px at viewport widths of 360px or less), 20px primary
  card headings, readable 16px fields and body copy. Secondary metadata can remain 14px. Native permission checkbox semantics
  and role-specific conversation colors are retained.
- The same compact mobile menu/brand/account header across pages; desktop keeps
  the navigation sidebar. At narrow widths, language selection is inside the
  Sections menu. Form controls and primary actions retain touch targets.
- Previously applied revision metadata is folded below the editor. Unsaved edits
  still have the existing fixed changes bar. Failed, waiting, busy and uncertain
  outcomes remain visible rather than being hidden in a clean-state disclosure.
- Provider cards add independent directory search and local-credential status
  filters. Catalog search in Add provider remains separate. Credentials are never
  displayed, and configured locally is not presented as a successful remote test.
- Scope controls, security warnings, explicit policy review/save, credential
  dialogs, MCP connection saves, retry/recovery and destructive confirmations
  retain their original behavior. No changes to backend permissions or transport.

## Coverage

| Destination | Presentation |
| --- | --- |
| Chats | Existing readable directory cards and access disclosure |
| Conversation logs | Shared frame, readable content and higher-contrast metadata |
| Shared defaults | Model, tool, skill and server summary cards |
| Providers and models | Search, status segments and provider cards; existing editors |
| Tool permissions | Scope segments and expandable source cards; policy limits retained |
| Skills | Readable instruction cards and explicit global/default selections |
| MCP servers | Connection cards and the existing guided/advanced editors |
| Secrets and variables | Runtime-value cards; write-only secrets and public-value warnings |
| GitHub mentions | Account/readiness and author-policy cards; security warnings retained |
| Audit | Record cards, filters, pagination and import history |

The signed-out screen, variables tab, provider detail, connection editor and policy
review dialog were also captured during acceptance checks.

## Local screenshot acceptance

`apps/admin/tests/admin-design-fixture.ts` intercepts every API request using
synthetic policy, inventory, chat, audit and runtime metadata. Conversation reads
fall back to the existing intercepted Durable fixture. No production API is used.
The dedicated acceptance tests assert that browsing/filtering never mutates data.

```sh
npm run test:browser --workspace @narumitw/sumire-admin -- tests/admin-design.spec.ts --workers=3
```

The spec produces 60 local captures: all ten pages at 320, 390, 768 and 1440px,
plus a 640px viewport at 200% CSS zoom; eight expanded-editor/dialog captures;
and two signed-out screens. Asynchronous metadata is awaited before capture.
Checks cover shared palette/type, contrast, folded clean metadata, horizontal
reflow, and the horizontal bounds of visible controls. Mobile and desktop page
captures were visually inspected, including the expanded editors and review flow.

Images are written only to ignored `apps/admin/test-results/` or local `/tmp/`
review directories. No screenshots, image links or generated image files are
included in the commit or PR description.

## Verification

```sh
npm run format:check
npm run lint
npm run typecheck
npm run build
npm test --workspaces --if-present -- --maxWorkers=2 --testTimeout=20000
npm run test:browser --workspace @narumitw/sumire-admin -- --workers=3 --timeout=20000
```

- The full browser suite passed: 700 tests in one execution. After the final
  desktop MCP card spacing refinement, the 30-test design/MCP/task/defaults
  acceptance group also passed.
- All 3,276 workspace unit tests passed with two workers and a 20s per-test limit,
  including 440 administration unit tests.
- The required plain root `npm test` was also attempted: eight bot tests failed
  under default concurrency/5s limits in this environment. The bounded rerun
  passed every workspace without changing backend code, assertions or timeout
  configuration. The default-command failure is not reported as a pass.
