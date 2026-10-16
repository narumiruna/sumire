# Extract contracts and policy packages

## Goal

Remove app-to-app source imports. Share management API types through `@narumitw/sumire-contracts` and policy schemas and pure rules through `@narumitw/sumire-policy`, without changing authorization or API behavior.

## Architecture

- `packages/policy` owns the existing policy schemas, types, initial values, effective selection, and reference validation. It depends only on Zod.
- `packages/contracts` owns Snapshot, Inventory, Chat, AuditEntry, and ImportReport API types. It has a type-only dependency on policy.
- Both apps consume package exports. Database access, authentication, API transport, React components, and presentation remain in their apps.
- Preserve the backend Snapshot epoch and existing MCP inventory fields. No database migration or endpoint changes.

## Plan

- [x] Inspect policy consumers, API producers, workspace build hooks, Docker stages, and CI. Evidence: admin imports bot policy source; backend Snapshot includes epoch; builds use explicit dependency hooks.
- [x] Create both private workspaces with exports, tests, and documentation; preserve policy implementation and add policy unit coverage. Evidence: policy source matches the original file exactly; five policy tests and one contracts test pass.
- [x] Update both apps and tests to package imports; annotate backend API producers with shared contracts and retain integration coverage. Evidence: bot and admin typechecks and all existing tests pass.
- [x] Update workspace dependency builds, lockfile, Docker stages, CI paths, repository documentation, and package changesets.
- [x] Run clean dependency installation, focused tests, root format check, lint, typecheck, tests, and build; review the final diff. Evidence: npm ci and all five required root checks pass; 1,426 unit/integration tests and 116 browser tests pass. Docker admin-build and bot build targets pass. Full runtime image and deployment are outside this extraction check and were not run.
- [ ] Commit intended paths on a new branch, push, and open a Conventional Commit-titled PR with the outcome and validation evidence.

## Completion Checklist

- [x] Neither app imports the other app's policy source; policy and API types each have one owner.
- [x] Required root checks pass. Disclose in the PR that full runtime image and deployment checks were not run.
- [ ] The PR contains only intended changes; the pre-existing untracked changeset remains untouched.
- [ ] PR URL is available. Remove this plan after all completion checks pass.

## Rollback / Recovery

Revert the extraction commit and reinstall dependencies. No production data or API migration is required.
