# GitHub Actions dependency lockfile

All workflows are onboarded to
[`.github/workflows/actions.lock`](../.github/workflows/actions.lock), generated
by the official [gh-actions-lock](https://github.com/github/gh-actions-lock)
extension. It records exact action commits, upstream references, repository and
owner IDs, and any transitive action dependencies discovered by the tool.
Never edit the lockfile by hand.

## Update workflow dependencies

Install the same extension version used by CI with an authenticated GitHub CLI:

```bash
gh extension install github/gh-actions-lock --pin v0.5.1
```

If the extension is already installed, check `gh actions-lock --version` and
explicitly upgrade or reinstall it when changing the version used by CI.

After adding or deleting a workflow, or changing any `uses:` reference, run from
the repository root:

```bash
gh actions-lock --no-interactive --no-narrow
gh actions-lock --verify-local
gh actions-lock --verify
git diff -- .github/workflows/
```

Use a full-directory run so deleted workflow entries are pruned. Keep
`--no-narrow`: without it the tool can rewrite full SHA references to tags.
Review and commit the workflow changes and regenerated lockfile together. Keep
the existing full-length SHA references; adopting the lockfile is not an action
upgrade.

Review changed commits as dependency upgrades. Investigate changes to
`owner_id` or `repo_id`, and unexpected transitive dependencies, before merging.
For an intentionally moved reference, review upstream history before running
`gh actions-lock --relock --no-narrow`. Never use `--accept-moved` in automation.

The existing GitHub Actions Dependabot configuration remains enabled. GitHub
documents automatic lockfile updates for already-onboarded workflows; review
those changes and require verification to pass just like manual updates.

## Verification and enforcement

[Actions Lockfile](../.github/workflows/verify-lockfile.yml) runs on pull requests,
pushes to `main`, and manual dispatch. It uses read-only `contents` permission,
the job's built-in GitHub token, and a version-pinned verifier. No new repository
secret is needed. `--verify` performs online coverage and provenance checks
without rewriting files; `--verify-local` is only an offline coverage check.
The CLI's bare-SHA advisory is expected while SHA references are deliberately
retained; it does not fail verification. Do not replace these SHAs with tags just
to silence that advisory.

A repository administrator can require the `verify-actions-lockfile` check in
branch protection or a ruleset. This PR does not change repository settings.

GitHub currently lists native workflow lockfile support under **GitHub
Enterprise Cloud**. Do not assume a successful CLI check enables runner-side
lockfile enforcement for this repository. Existing full-SHA `uses:` references
are retained, so unsupported accounts do not fall back to mutable tags. Without
native support, CI verification does not itself make runners enforce transitive
lockfile entries. Administrators must confirm feature availability, action
allowlists, and runner compatibility before relying on native enforcement.

## Scope and limitations

The lockfile does not lock runner images, container image tags, package installs,
downloads in `run:` steps (including the verifier installation), inputs, or
secrets. The verifier's release is version-pinned, not covered by `actions.lock`.

Remote reusable workflow calls at `jobs.<id>.uses` must still use a full commit
SHA; their action dependencies belong to the called repository's own lockfile.
A lockfile is an inventory and integrity control, not proof that an action is
safe.

References:

- [Workflow dependency lockfiles](https://docs.github.com/en/actions/concepts/security/workflow-dependency-lockfiles)
- [Lock workflow dependencies](https://docs.github.com/en/actions/how-tos/secure-your-work/lock-workflow-dependencies)
- [Enforce workflow lockfiles](https://docs.github.com/en/actions/how-tos/administer/enforce-workflow-lockfiles)
