# Kabigon Loader Parity Plan

## Goal

Verify behavioral parity between `packages/url-content` and Kabigon's registered loaders without adding duplicate loaders that already exist.

## Context

The comparison baseline is Kabigon `0.19.6` at commit `b68986bd4bf76f89aeacde31ad278e1d067ddb65`.
The authoritative inventories are Kabigon's `src/kabigon/loader_registry.py` and Sumire's `packages/url-content/src/loader-registry.ts`.
All 20 Kabigon loader IDs already exist in `packages/url-content`, so the missing-loader list is empty.

| Category | Kabigon loader IDs | `url-content` counterpart |
| --- | --- | --- |
| Social | `ptt`, `twitter`, `truthsocial`, `reddit`, `reel` | Same registered IDs |
| YouTube and media | `youtube`, `youtube-ytdlp`, `ytdlp` | Same registered IDs |
| Documents and code | `pdf`, `pi-session`, `github` | Same registered IDs |
| News | `bbc`, `cnn`, `ltn` | Same IDs backed by the shared `news.ts` implementation |
| Generic web | `playwright-networkidle`, `playwright-fast`, `playwright`, `curl-cffi`, `httpx`, `firecrawl` | Same registered IDs |

`packages/url-content` additionally provides `anydoc`, `google-docs`, and `threads`.
Kabigon's `loaders/audio.py` is a support module used by transcription code, not a registered loader, so it is not a missing loader ID.

## Non-Goals

- Do not mirror Kabigon's Python file layout when the TypeScript implementation already exposes the same loader contract.
- Do not remove the additional `anydoc`, `google-docs`, or `threads` loaders.
- Do not claim behavioral parity from matching names alone.

## Plan

- [ ] Record a versioned parity matrix for all 20 loader IDs covering URL applicability, pipeline placement, content type, requirements, resource kind, timeout, response or media limits, cancellation, output shape, and typed failures; acceptance evidence: each field links to both registries or implementations at the stated baseline.
- [ ] Audit pure request loaders (`ptt`, `github`, `pdf`, `pi-session`, `bbc`, `cnn`, `ltn`, `httpx`, `curl-cffi`, `firecrawl`) and list only observed behavioral gaps; acceptance evidence: deterministic fixture tests reproduce every gap before implementation.
- [ ] Audit browser and social loaders (`twitter`, `truthsocial`, `reddit`, `playwright-networkidle`, `playwright-fast`, `playwright`) for selector targeting, blocker rejection, redirect safety, browser admission, and cancellation; acceptance evidence: tests cover requested-content verification and failure fallback behavior.
- [ ] Audit media loaders (`youtube`, `youtube-ytdlp`, `ytdlp`, `reel`) for transcript preference, executable requirements, download and duration bounds, process-tree termination, temporary-file cleanup, and timeout mapping; acceptance evidence: worker tests use mocked commands and verify cleanup after success, failure, timeout, and cancellation.
- [ ] Implement each verified gap in a focused change without renaming loader IDs or weakening public-target validation; acceptance evidence: the reproducing test passes and existing source-specific contract tests remain green.
- [ ] Add a registry contract test that fixes the Kabigon baseline set and separately documents Sumire-only loaders; acceptance evidence: the test fails when a baseline loader disappears or is silently renamed.
- [ ] Update `packages/url-content/README.md` with verified compatibility limits and add changesets only for packages whose runtime behavior changes; acceptance evidence: documentation distinguishes name parity from behavioral parity.

## Completion Checklist

- [ ] Every Kabigon `0.19.6` loader ID remains available through `listLoaderNames()`.
- [ ] Every source-specific URL resolves to the intended pipeline and content contract.
- [ ] Every verified parity gap has a deterministic regression test and implementation evidence.
- [ ] `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` pass from the repository root.
- [ ] A live smoke matrix is run only for sources that cannot be proven with fixtures, with credentials and private URLs excluded from logs.
