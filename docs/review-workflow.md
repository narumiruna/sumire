# Pull request review workflow

The [PR Review workflow](../.github/workflows/review.yml) uses Pi to review pull request diffs. It does not check out or execute pull request code. It supports pull requests to `main` and manual runs from the trusted `main` branch. It skips Dependabot events.

The workflow pins review and `persist-auth` to the same pi-actions v0.3.0 commit. The separate persistence step saves valid refreshed credentials even when review fails. Review keeps its failed status. Only persistence receives `PAT_TOKEN`; review comments use the normal `GITHUB_TOKEN`.

## Required GitHub configuration

Complete this setup before enabling the workflow:

1. Stop all consumers of the OAuth login during migration or recovery.
2. Configure the `pi-oauth` GitHub Actions environment. Restrict it to trusted workflow revisions and permit jobs from `main`.
3. Store a fresh, CI-only Pi `auth.json` as that environment's `PI_AUTH_JSON` secret. The workflow selects `provider: openai`, as in the current pi-actions workflow. The document must contain a valid `openai` OAuth entry with `type`, `access`, `refresh`, and `expires`. Do not use only an `openai-codex` entry or share this login with local sessions or other repositories.
4. Configure the repository secret `PAT_TOKEN`. Fine-grained tokens need **Environments: read and write** for this repository. Classic tokens need `repo` scope and repository access. Confirm metadata access and a write with a synthetic environment secret before using real OAuth data. Preserve permissions required by other workflows that use this token.
5. After confirming the environment secret, remove any repository or organization `PI_AUTH_JSON` fallback available to the job. A fallback can hide a missing job environment and load stale credentials when the workflow is queued.
6. Give every job that uses this login the same `pi-oauth` environment and job-level concurrency group `pi-oauth-auth-json`, with `cancel-in-progress: false`. Do not add a PR number or workflow name to this group, or workflow-level automatic cancellation.

No bot runtime environment variable, `.env`, or deployment setting changes. Never put credential values in logs, comments, outputs, artifacts, or commits.

GitHub reads environment secrets when a job starts. The shared lock keeps loading, refresh, and writeback in one protected job. It does not coordinate local sessions or other repositories. Pending jobs can replace older pending jobs; concurrency is not a FIFO queue.

## Verification

Local regression tests check the trusted event, action pins, job environment and lock, provider, private handoff path, and failure-time persistence configuration:

```bash
npm test --workspace @narumitw/sumire -- tests/review-workflow.test.ts
```

The repository owner must complete these controlled live checks before relying on automatic refresh:

1. Confirm environment restrictions, credential validity, and the writer token's live permissions. Secret metadata alone does not verify them.
2. From trusted `main`, run a review on a controlled pull request:

   ```bash
   gh workflow run review.yml --ref main -f pull-request=123
   ```

   Replace `123` with the test pull request number. Confirm successful review and persistence without printing credentials.
3. Queue another review while the first job refreshes its credential. Confirm the waiting job starts with saved state and does not report `refresh_token_reused`.
4. In a controlled test configuration, cause a review failure after a valid refresh. Confirm the independent persistence step runs, the review stays failed, and the next review succeeds. Confirm private handoff cleanup after successful, unchanged, and rejected saves.

These live checks are not established by local tests. The code repair does not replace secrets or start live reviews.

## Failure and recovery

Run [42569113999](https://github.com/narumiruna/sumire/actions/runs/42569113999) failed with `refresh_token_reused`. The old workflow did not save refreshed credentials and permitted concurrent PR reviews with the same login. Updating the workflow cannot repair an already consumed refresh token.

If the environment credential is also consumed, stop all consumers, obtain a fresh CI-only login, and replace `pi-oauth/PI_AUTH_JSON`. Fix writer permissions before restarting. Do not restore an old auth document or repeatedly retry the consumed token.

The separate save occurs after review. A failed save fails the job, but cannot undo comments already published. Runner loss, timeout, or forced cancellation can still interrupt refresh before writeback and require a fresh login.

To roll back standalone persistence, remove both `auth-output` and the `persist-auth` step. Use inline persistence or API-key authentication supported by pi-actions instead. Keep remaining OAuth consumers serialized. Do not revoke a shared `PAT_TOKEN` merely because this workflow stops using it.

See the upstream [OAuth setup and recovery guide](https://github.com/narumiruna/pi-actions/blob/v0.3.0/docs/oauth.md) and [persist-auth contract](https://github.com/narumiruna/pi-actions/blob/v0.3.0/persist-auth/README.md).
