# Package update review

## Target and evidence

- Repository: `narumiruna/sumire`.
- Pull request: https://github.com/narumiruna/sumire/pull/235.
- Reviewed head: `7399c4bdcb442c1b703bc1bafecfb705cce275c1`.
- Goal: update dependencies without downgrades and retain the existing bot behavior.
- Read the description, commit, complete 8,294-line patch, all 43 changed files, checks, submitted review, inline comment, and conversation comments. REST endpoints each had one page. Review threads and their comments each had no next page.
- The Pi review summary and submitted review refer to R1 below. They are not separate findings. The Codex status comment contained no code finding or requested change when fetched.
- The original head passed `typescript`, `container`, and `review`. The container job builds `runtime-application`; it does not test the final image's native Chrome profiles.

## Review ledger

### R1: Keep nested completion results

- Feedback: https://github.com/narumiruna/sumire/pull/235#discussion_r4457407377.
- Severity: P2. Existing session listeners lose nested tool result data.
- Scope: the observation migration in this pull request replaces an event path that passed nested results to listeners.
- Supporting evidence: `forwardDurableView` reads results only from direct result entries. Nested slots have no entry and emit `result: undefined`. Pi 1.4 read nested results from committed `NestedCallDoc` changes before the parent retired those documents.
- API evidence: Pi 1.5 stores the nested payload in `NestedCallDoc`. The terminal task receipt contains only `{ kind: "nested" }`. A later task read cannot recover the payload. The payload includes `structuredOutput`, `details`, diagnostics, usage, and timing. Model-only `output` is not retained for nested calls.
- Initial outcome: Actionable and not yet addressed.
- Final outcome: Already addressed by this review fix.
- Fix: capture nested payloads from stored commit publications before parent retirement. Pass the full payload to the completion event. Release captured data after delivery, branch restore, or shutdown.
- Proof: the new success and error tests failed before the fix and pass after it. Tests cover retained payloads after parent retirement, conversation isolation, one completion per call, missing-result faults, stale-result cleanup, and commit-observation cleanup. The real codemode test checks Bash output and URL failure details in nested events.

### R2: Match the native library to `impers`

- Source: independent review of `packages/url-reader/package.json` and the production build.
- Severity: P1. The final production image cannot pass its existing native compatibility check.
- Scope: this pull request updates `impers` from 0.1.2 to 0.1.3. That update adds Chrome 151/152 profiles and changes the default `chrome` alias to `chrome152`.
- Supporting evidence: the installed loader specifies curl-impersonate v2.3.2. `scripts/install-curl-impersonate.sh` still downloads v2.2.2. The existing offline check fails with `CurlError` code 43 against v2.2.2 for the new Chrome profiles. Chrome 150 works with that library.
- Build evidence: the final Docker stage sets `LIBCURL_PATH` to the pinned library and runs `apps/bot/scripts/check-curl-impersonate.mjs`. The passing CI container job stops at the earlier `runtime-application` stage.
- Initial outcome: Actionable and not yet addressed.
- Final outcome: Already addressed by this review fix.
- Fix: pin v2.3.2 and update both Linux archive SHA-256 values. Keep the HTTPS rules, retry bounds, checksum gate, extraction patterns, and runtime library path unchanged. Update the image comment and setup documentation.
- Proof: actual archive hashes match the public release metadata. Five new offline tests check the dependency version, both architecture downloads, and rejection before extraction when a checksum fails. The real installer and all 24 Chrome profiles pass on both Linux architectures with networking disabled.

## Validation of the review fixes

- All root checks pass: `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
- Root tests: 3,168 tests across 189 files. Lint retains 5 existing CSS warnings and 1 informational finding.
- `sh -n scripts/install-curl-impersonate.sh` and `git diff --check` pass.
- Both Linux archives were downloaded and hashed. Their hashes match the GitHub release metadata:
  - x86_64: `7716be1ec87f13ecc776c211003bd1122c345287829b1f18a494a5467c90ab1e`.
  - aarch64: `1cb74a3b5103df020c252f9efef5a779c87380ee6244b365a90a0e4f7086864e`.
- Native checks used disposable existing Docker images. ARM64 used Node.js 26.13.0. AMD64 used Node.js 24.21.0 under emulation. Both images used Koffi 3.3.1. The installed impers 0.1.3 files were mounted read-only. The installer used the verified local archives, then the real Chrome check ran with networking disabled.
- Validation limit: no fresh full production image was built. The native checks do not claim full image or deployment acceptance.

## Other outcomes

- No out-of-scope deferral or missing user decision was found.
- Existing moderate npm audit findings are unchanged. This review does not add forced dependency downgrades or unrelated security changes.
- No production state or deployment was changed.
