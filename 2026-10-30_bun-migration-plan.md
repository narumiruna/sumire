# Full Bun Migration Plan

## Goal

Use Bun for dependency installation and all repository-owned JavaScript execution: development, type checking, builds, tests, package tooling, MCP launchers, Docker checks, the container entrypoint, and the Compose healthcheck. Do not retain a real Node.js runtime or npm/npx fallback in these paths.

Implementation is authorized by the current execution request. Do not publish packages, push release tags, deploy services, or use production credentials during implementation checks.

## Context

- The root `package.json` owns 12 workspaces under `apps/*` and `packages/*`. Every workspace is currently private and requires Node.js 26. Some private packages retain public `publishConfig` metadata; this does not authorize publication or establish a working public publisher.
- Root and workspace scripts use npm workspace selection and lifecycle hooks. `version-packages` regenerates `package-lock.json` through npm. `.npmrc` enables strict engine checks; root `allowScripts` permits selected dependency scripts.
- `Dockerfile` uses five Node-based stages, npm installation/pruning, Node smoke checks, and a Node entrypoint. `compose.yaml` also invokes Node for its healthcheck.
- `mcp.json`, `mcp.docker.json`, and `apps/bot/scripts/chrome-devtools.mjs` use npx/Node. The URL-reader CLI has a Node shebang, and its bundled skill instructs Pi to invoke Node. The installed Otter CLI also needs a direct-executable check.
- Pi integration explicitly imports Node environment, SQLite, and image adapters in `apps/bot/src/agent/pi-session-factory.ts`, `apps/bot/src/agent/durable/tools.ts`, `apps/bot/src/admin/import.ts`, and `apps/bot/src/github/generation.ts`. Shell authorization depends on environment isolation and authorization immediately before spawn.
- Tests use Vitest-specific mocking and isolation. `apps/bot/tests/node-runtime.test.ts`, `container-packaging.test.ts`, and `browser-runtime.test.ts` assert current Node/npm behavior. The bot coverage configuration selects V8.
- The planning host has Bun 1.4.4 and Node.js 26.11.1, but no installed workspace dependencies. A Bun 1.4.4 in-memory SQLite query and `backup()` passed. This is not evidence for application, progress-callback, recovery, or native-module compatibility.
- Docker initially failed before reaching its daemon. Access was restored on 2026-10-31: Engine 29.7.2, Docker Desktop 4.90.0, linux/amd64. A disposable Bookworm qualification image now runs, but it confirms the native Bun crash. Full production-container validation still depends on the preceding migration gates.

## Scope and Constraints

- Pin one validated Bun version across package metadata, CI, and Docker. Bun 1.4.4 is the first candidate, not a compatibility guarantee.
- Preserve workspace ownership, compiled ESM exports, declaration output, Pi Harness ownership, authorization, persistent paths, file permissions, and deployment tag rules.
- Keep compatible `node:*` APIs and Node API types. A runtime migration does not require an API rewrite. Use supported Pi adapters; do not introduce another model loop or patch ignored dependency output.
- Retain TypeScript, Vite, Biome, Playwright, and Changesets where their required behavior works under Bun. Retain Vitest only if its suites actually run under Bun. Do not replace type checking with Bun transpilation.
- Keep Debian Bookworm for the container OS. Copy the pinned Bun executable from an official image into a shared Bookworm stage. Use plain Bookworm stages where only system or Python tools are needed. This avoids an unrelated libc/OS migration.
- Keep Python, Whisper, Torch, yt-dlp, Deno, FFmpeg, Git, GitHub CLI, SSH, Chromium, and libcurl. Do not change their versions merely to rename the JavaScript runtime.
- Approved extension (2026-10-31): change or replace the native transport dependencies to provide Bun-compatible asynchronous libcurl execution. Preserve libcurl impersonation, public APIs, address/redirect defenses, streaming limits, cookies, cancellation, and ownership/cleanup. Review and document every required dependency change. Do not edit ignored dependency output, introduce a real Node fallback, or weaken the remaining gates.
- Do not change database schemas, package privacy, bot behavior, model providers, environment-variable names, or public exports as an incidental cleanup. Do not add runtime switches or a dual-runtime fallback.
- GitHub Actions' internal runtime and the npm registry are not repository-owned Node/npm execution. Do not replace hosted Actions merely because their implementation uses Node.
- Do not rewrite historical changelogs or unrelated plans. Change current executable instructions and configuration only.

## Plan

Tasks are dependency-ordered. Keep evidence in this plan during authorized execution. A failed compatibility gate blocks dependent implementation; do not silently reduce the goal to package-manager-only adoption.

- [x] **1. Capture the current baseline.** Inventory executable entrypoints, workspace dependencies, lifecycle hooks, test discovery, package contents, and release behavior before changing them.
  - Use the existing npm lockfile and a clean, disposable validation checkout for baseline installation and builds. Do not remove user state or edit ignored output as a migration fix.
  - Run the current root checks and record versions, exit statuses, test inventory, artifact contents, and any unrelated failures. Preserve a Node-created synthetic database fixture for later cross-runtime tests.
  - Acceptance: the execution inventory and baseline results identify the expected behavior for subsequent gates. Unrelated failures remain recorded; mandatory checks are not waived.
  - Evidence (2026-10-30): clean detached checkout `342758abc56814132a26771f24c4cdbcde4b5daa`, Node.js `26.11.1`, npm `11.20.0`, Linux x86_64. `HUSKY=0 npm ci` passed; Husky was disabled to avoid changing the linked worktree's shared Git hooks. Root `typecheck`, `test` (188 files, 3,074 expanded cases), and `build` passed. Root `format:check` and `lint` failed because the installed Biome wrapper cannot resolve its optional Linux x64 binary; these failures are not waived. Vitest discovery records 1,756 definitions; Playwright discovery records 639 cases in 39 files, not executed browser acceptance. All 12 workspace archives and inventories, install-policy and executable inventories, and synthetic Node-created SQLite/admin/encrypted-settings/durable/GitHub/crash fixtures are retained under `/tmp/sumire-bun-validation.tgbTZ3/`. Fixture manifest: `fixtures/node-26.11.1/manifest.json`. Root check exit statuses: `logs/status.tsv`.
  - Prepared-tool repeat: all five root npm checks later pass from the same clean baseline with the wrapper-supported `BIOME_BINARY` pointing to the isolated official Biome `2.6.3` executable. No source/lockfile/dependency output was patched; the original clean-install failures remain recorded. Exact repeat logs/statuses: `prepared-node-checks/` under the same evidence root. This is not task 11's migrated Bun-script acceptance.

- [ ] **2. Qualify Bun for application and native execution.** After task 1, test the pinned Pi packages and runtime dependencies under Bun with synthetic data and local endpoints.
  - Exercise Pi environment/storage/image adapters, read/write/edit/bash tools, codemode, shell credential isolation, revocation at spawn, and cancellation. Consult the pinned upstream API documentation before changing adapters.
  - Test SQLite transactions, custom functions, iteration, backup progress/deadlines, legacy imports, encrypted settings, restart, crash recovery, and Node-created state. Test AnyDoc's eval arguments, stdin/output bounds, abort settlement, and descendant termination.
  - Perform real local document/PDF/image conversion, Koffi/libcurl requests to a local test endpoint, Chromium launch, and telemetry export/shutdown against a local collector. Imports alone do not pass this gate.
  - Use disposable probes to establish supported implementations and identify required source adaptations; the unchanged application need not pass before its entrypoints are migrated.
  - Acceptance: required capabilities have passing Bun probes without real Node/npm executables, and necessary source adaptations, adapters, and platform requirements are recorded. Unsupported capabilities remain blocking, not skipped; integrated regression gates follow later.
  - **Blocked, confirmed on Bookworm (2026-10-31):** the pinned `impers.get`/`Session.request` path calls `koffi.node.poll`; the official Bun `1.4.4` executable aborts with exit 134 at unsupported `uv_poll_init_socket`, as uid 65532 with no Node/npm/npx and no external network. The same request passes in a separate Node.js `26.11.1` Bookworm control. Pinned Bun POSIX source contains unconditional polling stubs; four additional public API paths also abort. Pool/protocol changes provide no supported alternate poller. No Node fallback, capability removal, or dependency-output patch was applied. The user approved replacement/dependency changes on 2026-10-31; qualify the selected implementation against the unchanged security, lifecycle, and public API requirements before proceeding.
  - Qualified environment adaptation (disposable copies only): a static internal `BUN_OPTIONS: "--no-env-file"` protects automatic loading in 28 CLI cases, 6 root/worker/fork observations, 30 real Harness cases, 32 existing tests, and 6 Bookworm controls. Do not forward host Bun flags. Explicit file access is not blocked; restricted forks from an explicit-env-file root host also need clean `execArgv`. No project adapter was applied, and `BUN_CONFIG_NO_ENVFILE=1` remains unsupported.
  - Lifecycle blocker confirmed on Bookworm (2026-10-31): the earlier four passing string-operation cases depend on CPU resources and cancellation timing. Repeated later timeout/abort cases fail even with the original single-CPU quota: result/close settle, but the worker does not exit before an external 3-second kill. No settings-only or Bookworm-only support boundary meets the requirement. Fifteen helper-process hard-stop controls pass, but a process-backed codemode adapter is not implemented or authorized by the separate native network-transport approval. Preserve the actual-death wait, Harness ownership, native fingerprints, replay, deadlines, and result contracts; task 2 stays open.
  - Passing partial probes include Pi environment/storage conformance, real spawn-time policy/token-replacement authorization, Node/Bun cross-runtime SQLite/encryption/hot-journal/WAL recovery, Photon, five AnyDoc formats and child abort/timeout, PDF parsing, and local telemetry export/shutdown. These do not satisfy the failed native/security/lifecycle gates. Retained results and reproducer: [docs/bun-migration-validation.md](docs/bun-migration-validation.md).

- [x] **3. Qualify Bun for developer and release tools.** After task 1, probe TypeScript, Vite/Rolldown, Biome, Playwright, Vitest, Changesets, and dependency-update tooling without Node/npm fallback.
  - Check test discovery, hoisted mocks, module resets, fake timers, environment stubs, setup hooks, worker isolation, and coverage. If Vitest cannot provide these under Bun, prove equivalent Bun-test patterns before converting suites; do not remove assertions or disable suites.
  - Inspect Changesets 3.0.3 and `changesets/action@v2` for delegated npm calls. In a disposable Git repository, test version/internal-dependency updates, lockfile refresh, private-package tags, and repeated-release behavior. Use dry runs or stubs; never push or publish.
  - Identify any reachable registry-publishing path and its authentication/provenance requirements. A private-package no-op is not publisher evidence. Do not invent a general publisher for hypothetical public packages; an unsupported required release path blocks the migration.
  - Verify current Dependabot support for the Bun lockfile before choosing its ecosystem configuration. An unsupported update flow needs an explicit disposition, not a stale npm-only configuration.
  - Acceptance: each retained tool executes under Bun, required runner conversions are defined, and release/update behavior has a supported implementation. Do not weaken provenance or change package privacy to pass.
  - Partial evidence (2026-10-30): pinned TypeScript, Vite/Rolldown, Biome, Playwright, Vitest, coverage providers, Changesets/private-tag/action fixtures, and recursive dependency updates execute under instrumented Bun without real Node/npm/npx. The unmodified 188-file suite has 3,057 passes and 17 failures; disposable source/test adaptations preserve all 3,074 cases and pass in 189 files (one explicit test split). No assertions or suites were removed from the repository, and no repository source/configuration was migrated. The retained report distinguishes fixture/tool capability from integrated acceptance and records an intermittent streamed-response shutdown failure.
  - Disposition (2026-10-31): official Dependabot supports text `bun.lock` version updates, not Bun security updates. Read-only repository API checks return `{"enabled":false,"paused":false}` and `dependabot_security_updates.status: "disabled"`. Preserve the existing weekly version-update flow with the supported Bun ecosystem; do not claim unsupported security updates or change GitHub settings. No enabled security-update flow is removed. Recheck the setting before changing automation; a later enabled control needs a supported solution. The current npm configuration remains unchanged. No public publisher or provenance support is inferred from private-package tagging.

- [ ] **4. Migrate dependency management.** After tasks 2 and 3 pass, pin Bun, migrate `package-lock.json` to root `bun.lock`, and update engine/package-manager metadata for all affected manifests.
  - Preserve locked dependency versions, integrity, optional platform packages, peer resolution, and local workspace links, except for the explicitly approved native transport changes. Review and explain every resolution change; do not combine this work with unrelated dependency upgrades.
  - Translate the current install-script policy to the smallest explicit Bun trust policy. Verify that denied scripts stay denied; do not use blanket trust. Keep Husky installation working.
  - Acceptance: two clean `bun install --frozen-lockfile` runs resolve the expected graph without modifying tracked files. Only one dependency lockfile remains after successful migration checks.

- [ ] **5. Migrate command orchestration.** After task 4, replace root/workspace npm commands, npm-based pre/post hooks, `prepack`, version-lock refresh, dependency updates, and the Polymarket generator invocation.
  - Use Bun workspace selection and runtime dispatch explicitly where tools have Node shebangs. Preserve dependency build order, failure propagation, arguments, working directories, and existing lifecycle behavior. Do not assume npm flags or hook semantics translate directly.
  - Acceptance: clean root/focused builds work without prebuilt `dist`; recording fixtures prove hook order, argument forwarding, and failure propagation. Instrument representative tool processes to verify `process.versions.bun`. Full test and application execution is checked after runner/entrypoint migration.

- [ ] **6. Migrate runtime entrypoints and subprocesses.** After tasks 2, 4, and 5, update bot dev/start commands, CLI shebangs, packaged skill execution, MCP launchers, check scripts, and admin comparison/browser-server commands.
  - Preserve root-only `.env` loading and existing environment precedence. Prevent Bun automatic env-file loading from restoring credentials in restricted child processes. Remove `tsx` only after no remaining command needs it.
  - Preserve the MCP package selector, protocol-only stdout, browser resolution, signal forwarding, and exit status. Test direct CLI and Otter execution outside the repository, not only invocation through `process.execPath`.
  - Acceptance: packaged CLIs, MCP transport, subprocess arguments, timeouts, aborts, and shutdown work with real Node/npm/npx absent. Restricted tools cannot inherit or reload unauthorized credentials.

- [ ] **7. Adapt test contracts to the selected Bun runtime.** After task 6, update source-runtime, MCP, and CLI expectations and crash-child launchers; apply only the runner conversions established in task 3. Update Docker/Compose and CI configuration assertions with their corresponding files in tasks 8 and 9.
  - Keep the existing security, delivery, persistence, mocking, and failure assertions. Preserve test discovery and coverage capability. Add direct-executable tests to cover shebangs that current `process.execPath` tests bypass.
  - Acceptance: focused affected suites pass under Bun, runtime-pin tests check actual Bun execution, and no compatibility failure is hidden by skipping a suite or relaxing its contract.

- [ ] **8. Migrate Docker and Compose execution.** After tasks 4 through 7, replace Node images, npm installation/pruning, build commands, check commands, entrypoint, and Compose healthcheck with Bun-based execution. Update their structural test assertions in the same step.
  - Use the same frozen lockfile for builder and separate production-only installation stages. Preserve the full workspace dependency closure without copying development dependencies into production. Preserve useful source/build/browser/audio cache boundaries.
  - Keep `/app`, `/workdir`, `.events`, `.telegramagent`, browser paths, volume mounts, the non-root app user/ownership, browser sandbox/seccomp policy, and required system tools unchanged. Test direct dependency binaries under the restricted runtime environment.
  - Acceptance: structural packaging/healthcheck tests pass and all repository-owned container JavaScript commands use Bun. Runtime acceptance still requires task 12; source inspection is not a substitute.

- [ ] **9. Migrate CI, release, and dependency automation.** After tasks 3 through 8, update workflows, install/cache paths, lockfile path filters, browser/comparison commands, Changesets version/release commands, and Dependabot configuration. Update workflow-coupled test assertions in the same step.
  - Preserve private-package versioning/tagging, `@narumitw/sumire@*` deployment triggers, existing secrets, registry settings, and required provenance behavior. Do not add an undocumented npm publisher fallback.
  - Acceptance: configuration checks cover Bun pin agreement and lockfile triggers; disposable release tests produce the expected versions/tags without npm and do not regenerate `package-lock.json`. No external release or deployment is performed.

- [ ] **10. Update current guidance and version metadata.** After executable commands stabilize, update root/workspace READMEs, `AGENTS.md`, `.changeset/README.md`, bundled skill commands, and relevant operations documentation.
  - Document verified Bun install/run/workspace/check/release commands and the runtime support boundary. Keep npm-registry terminology where accurate. Follow the applicable instruction/skill-authoring guidance when editing those resources.
  - Replace the planning-only empty changeset with version bumps for every affected workspace, including private packages. Select SemVer changes that match any removed runtime support; do not use an empty changeset for the implementation.
  - Acceptance: current instructions match tested commands, all affected packages are covered, and no runtime environment variable was changed without the required example/deployment documentation updates.

- [ ] **11. Run clean local regression gates.** After tasks 7 through 10, run the root Bun scripts for formatting, lint, type checking, all unit/integration tests, and builds; run admin Playwright flows and comparison capture with synthetic fixtures.
  - Also run `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` on the transitional validation host, as required by the current repository instructions. These wrappers must dispatch migrated Bun scripts; Node/npm are not target CI or image dependencies.
  - Pack affected packages locally and verify exports, declarations, binaries, and bundled skills from an isolated consumer directory. Repeat the install/build/check sequence with no pre-existing build artifacts and no real Node/npm on executable paths.
  - Acceptance: mandatory gates pass, expected tests remain covered, generated catalogs are current, and archives are complete. Record exact commands/results; unresolved mandatory or change-caused failures block completion.

- [ ] **12. Run container and persisted-state regression gates.** After tasks 8, 9, and 11, build `runtime-application` and the complete production image, then run checks as the app user with synthetic configuration and disposable volumes.
  - Docker access is restored and actual non-root Bookworm qualification probes ran on 2026-10-31. Native requests still crash Bun. The small qualification image is not `runtime-application` or the production image. This task and its completion check remain open until the prerequisite migration gates pass and the full image/state checks execute; no administrator action is currently needed for daemon access.
  - Run offline application imports, image/document conversion, browser and curl checks, media/tool checks, MCP fixture transport, the real healthcheck, graceful restart, and forced-crash recovery. Verify production dependency contents and that no real Node/npm/npx runtime is required by descendants.
  - Reuse copied Node-created synthetic state and test Bun-to-previous-runtime recovery without a schema change. Check volume ownership and prevent concurrent state owners. Validate every deployment architecture actually configured; record the tested platform.
  - Acceptance: production images and local Compose-equivalent checks pass on supported target platforms, with persistent-state and security assertions intact. Do not contact Telegram, model providers, or production services.

- [ ] **13. Retain validation and handoff evidence.** After all required agent checks pass, record versions, commands, platforms, compatibility decisions, remaining external checks, and rollback instructions in `docs/bun-migration-validation.md`.
  - Audit current executable sources/configuration for Node/npm/npx fallbacks, excluding compatible `node:*` APIs, registry names, historical records, and platform-owned Actions internals. Include package binaries and generated artifacts in the execution audit.
  - Acceptance: every completion check below has evidence, material compatibility questions have a disposition, and external roles can use the retained handoff without secrets. Only then delete this completed plan. Do not delete a blocked or merely drafted plan.
  - Partial qualification evidence and blocking handoff are retained in [docs/bun-migration-validation.md](docs/bun-migration-validation.md). Task 13 is not complete: task 2 and all integrated completion checks remain open. Tasks 1 and 3 have evidence. The evidence-only PR uses an empty changeset because no package implementation or supported runtime changed; the eventual implementation still requires the workspace version bumps in task 10.

## Completion Checklist

- [ ] One pinned Bun runtime and one root `bun.lock` support reproducible full and production-only installations with the reviewed script trust policy.
- [ ] Repository-owned commands and shipped JavaScript descendants work without real Node/npm/npx; direct-executable and environment-isolation tests prove this.
- [ ] Type checking, declaration output, generated catalogs, formatting, lint, all retained tests, browser flows, builds, and package checks pass; required transitional npm verification is recorded.
- [ ] Pi ownership, authorization/revocation, URL/network defenses, bounded streaming, cancellation, telemetry shutdown, and durable delivery/recovery retain their tested behavior.
- [ ] Node-created state opens under Bun, and rollback fixtures remain readable by the previous runtime without schema or encryption changes.
- [ ] Complete production images pass non-root native/browser/media/health/restart checks on configured deployment platforms. An unavailable Docker engine does not satisfy this check.
- [ ] Release/version/private-tag and dependency-update flows have verified Bun execution; required authentication/provenance behavior is not silently removed.
- [ ] Guidance and changesets cover the implementation; final evidence, external handoff, and release restrictions are retained before the completed plan is deleted.

## Rollback / Recovery

- Before an authorized production rollout, the release operator must retain the previous source revision and image under an immutable tag that survives the deploy workflow's image pruning.
- Stop the service before making consistent backups of persistent databases and associated state. Keep required encryption/authentication material in approved host storage, never in Git or this document. Do not test on live state.
- Keep storage formats, mount paths, ownership, and encryption unchanged. Prove the previous runtime can read synthetic state written by Bun before rollout; if it cannot, stop and define recovery before release.
- To roll back, stop the Bun instance and restore the previous image/configuration. Only one process may own a chat's durable state. Restore the consistent backup only if required; never delete volumes with `docker compose down -v`.
- A local code rollback must restore manifests, scripts, workflows, Docker/Compose configuration, and `package-lock.json` together. Reinstall in a disposable validation environment; do not mix lockfiles or partial runtime changes.
- A bad release must use a new corrective version/tag. Do not force-move published tags or repeat admitted external side effects during recovery.

## External Handoff

These actions are not agent completion checkboxes and are not authorized by this plan.

| Responsible role | Prerequisite | Action and expected result | Unverified behavior and release restriction |
| --- | --- | --- | --- |
| Repository/release administrator | Agent gates pass; existing Actions credentials and permissions are available through approved secret storage | Run the first authorized Bun release and verify the release PR, private-package tags, and the bot deployment trigger. Confirm no private package is published. | Actual GitHub auth/tag-trigger behavior is not proven by local fixtures. Do not infer public publishing or provenance support from private-package no-op success; any public publish requires separate explicit authorization and verification. |
| Deployment operator and bot administrator | Previous image and consistent backups retained; an approved canary environment and accounts are available | Perform an authorized canary rollout and check health, existing conversation restoration, Telegram delivery, MCP, and restart before promoting the image. | Live Telegram/provider authentication and delivery remain unverified by offline tests. Keep rollout limited to the canary until those operational checks pass. Do not request credentials in chat. |
