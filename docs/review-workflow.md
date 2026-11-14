# Retired pull request review workflow

The Pi-based PR Review workflow was removed in [#285](https://github.com/narumiruna/sumire/pull/285). The repository no longer runs `.github/workflows/review.yml` or its OAuth credential persistence step.

The workflow-specific tests and CI path filters have been removed. CI must validate the current repository without requiring the deleted workflow. Do not restore it or skip failing tests as a CI repair.

## Credentials

No review workflow setup, manual dispatch, or credential replacement is required for this CI repair. Removing the workflow does not remove GitHub secrets or revoke tokens. Only the repository owner can decide whether the former `pi-oauth` environment and `PI_AUTH_JSON` secret are unused. Do not revoke `PAT_TOKEN` if other workflows still use it.

For historical OAuth recovery details, see the upstream [Pi Actions OAuth guide](https://github.com/narumiruna/pi-actions/blob/v0.3.0/docs/oauth.md). No live credential changes are verified or required by the workflow retirement.
