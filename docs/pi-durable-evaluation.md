# Pi Durable evaluation

## Decision

**No-Go for replacing Sumire's production runtime with Pi Durable 1.0.4.**

Evaluated on 2026-10-06 against Sumire base `8c04a63b1994577011445f56c467435e3a65b1d4`. The execution request delegated the plan's Go / No-Go decision; this report records the No-Go outcome, not a request for another approval or a claim that migration occurred.

Pi Durable can persist and resume the work tested here. It can replace application file persistence and branch-state reconstruction. However, the experiment did not establish a net maintenance reduction for Sumire's complete capabilities. Safe adoption also requires host policies that are not supplied by a thin tool registration:

1. `requestId` deduplication is conversation-scoped. A reply fork can admit the same Telegram update again.
2. Durable admission does not persist Telegram delivery metadata automatically. A host ledger must close the admission-to-metadata gap, cover answers finished during downtime, and coordinate routing, cancellation and reset.
3. `replay: "unsafe"` prevents automatic replay of an interrupted call. It does **not** prevent the resumed model from issuing a fresh call for the same external action. A scripted model reproduced that case after a real process crash. This is expected replay-policy semantics, not an upstream defect.
4. External success followed by a missing receipt is uncertain. Automatically retrying can duplicate a Telegram send or Morsel publication; refusing retry can leave a successful answer undelivered. An operator/reconciliation policy remains necessary.

Sumire exposes Morsel publication and expense management through coding tools. `MorselPublisher` currently sends a POST without an idempotency key; arbitrary `bash` operations cannot all be treated as replay-safe. Automatic recovery introduces additional occasions for fresh duplicate actions compared with the existing non-resuming host orchestration. This evaluation does not authorize adding that risk to production merely to reduce maintenance.

**Outcome:** keep `AgentSession`, current package versions, startup, commands, tool packages, state volumes and architecture rules unchanged. Remove prototype-only sources and dependencies from the final tree. No production data, credentials, external services, releases or deployment were modified.

## Reproducible experiment

The signed experiment snapshot is commit [`f6c157ec3a305c8cfd749d8744fe5519973b4d51`](https://github.com/narumiruna/sumire/commit/f6c157ec3a305c8cfd749d8744fe5519973b4d51), retained in this PR's history. It was deliberately removed from the final tree after the No-Go decision; it is not an optional production backend.

The snapshot contains:

- `apps/bot/src/agent/durable-prototype/runtime.ts`: independent per-chat SQLite/Harness experiment, never imported by production startup.
- `apps/bot/src/agent/durable-prototype/delivery.ts`: synthetic sender ledger, with `pending`, `uncertain` and `delivered` outcomes.
- Four `apps/bot/tests/durable-*.test.ts` suites, cleanup support, and a child-process crash fixture.
- Exact dev dependency pins for Pi Durable and Chord 1.0.4, plus a `pi-durable-ai` alias for pi-ai 1.0.4. Existing production pi-ai remains 1.0.2.

To reproduce without changing an existing checkout, create a separate worktree. Run the following from the repository root, then use the indicated worktree as its root:

```bash
git fetch origin f6c157ec3a305c8cfd749d8744fe5519973b4d51
git worktree add --detach ../sumire-pi-durable-eval f6c157ec3a305c8cfd749d8744fe5519973b4d51
cd ../sumire-pi-durable-eval
npm ci
npm run test --workspace @narumitw/sumire -- tests/durable-runtime.test.ts tests/durable-recovery.test.ts tests/durable-reply-tree.test.ts tests/durable-delivery.test.ts
```

Node.js 22.19 or newer is required; the recorded run used Node.js 26.10.0 and npm 11.19.1. Tests use faux providers, temporary SQLite stores, a synthetic image, local counters and sender doubles. They need no `.env`, Telegram bot, OpenAI login, Morsel key or Otter credentials. The child fixture's counters instrument invocations; declaring its read-only probe safe is not guidance to mark file-mutating production tools safe.

### Results

All **24 experiment tests passed**. The negative-control tests intentionally prove a missing upstream guarantee; passing them does not mean that guarantee was implemented.

| Suite | Cases | Evidence |
|---|---:|---|
| `durable-runtime.test.ts` | 6 | Graceful close/resume; synthetic image input and image tool results; same-conversation deduplication after reopen; chat-isolated physical reset preserving a separate synthetic auth file; busy steering/follow-up/passive writes; cancelled waiter versus explicit active/queued abort. |
| `durable-recovery.test.ts` | 7 | Actual `SIGKILL` after admission, during generation, with queued work, and inside safe/unsafe tools; cancellation before resume without a provider call; interrupted unsafe call not replayed automatically, but a new model-issued duplicate action still executes. |
| `durable-reply-tree.test.ts` | 5 | Count and byte eviction; aliases and oversize transaction rollback; checkpoint fork after reopen with recent passive context before the current question; as-of document state across a compaction entry and fork; duplicate request admitted in a new fork. |
| `durable-delivery.test.ts` | 6 | Missing host metadata after durable admission; late cancelled work refused; answered-but-undelivered recovery with receipt; uncertain synthetic Telegram/Morsel success after failure before receipt; concurrent delivery claims and transport failure. |

The compaction experiment inserts a valid compaction entry to test context cuts and as-of document behavior. It does **not** test provider-generated summaries, automatic thresholds or context-overflow recovery. Delivery tests inject a failure after synthetic external success and reopen the store; only the admission/generation/tool recovery fixtures use `SIGKILL`. No exactly-once claim is made.

## Compatibility matrix

“Needs adaptation” means an identified host responsibility or unverified integration, not a failing current-runtime test. These paths were not migrated because of the No-Go decision.

| Capability | Existing evidence | Durable evidence or adoption requirement |
|---|---|---|
| Text, busy input and passive context | `session-registry.test.ts`, `pi-passive-context.test.ts`, `bot.test.ts` | Experiment verifies persisted input/queues and passive ordering. Sumire still owns addressing, pre-admission ordering and late-result invalidation. |
| Cancel and reset | Registry/bot tests | Abort withdraws active and queued inputs; cancelling a waiter alone does not. Physical store deletion is needed to preserve current `/reset`; the native context-reset operation retains history. Prototype isolates a separate auth file, not real OAuth credentials. |
| Reply tree and bounds | `pi-reply-tree.test.ts`, `reply-index.test.ts` | Fork/as-of documents and bounded alias storage work. Chat routing, passive-context carryover, unresolved-reply text fallback, reset invalidation and chat-wide update deduplication remain host responsibilities. |
| Progress | `packages/progress/tests/progress.test.ts` | Rewindable/as-of document snapshots work with synthetic steps. Canonical schema validation, model-facing progress context and Telegram rendering still need integration; the existing `ExtensionAPI` hooks do not load directly. |
| Coding tools and URL loading | Factory and URL tool tests | Durable supplies CodingTools but requires an execution environment. Sumire's bounded URL loader can be reused; its registration and AbortSignal/Chord cancellation bridge need adaptation. SSRF, redirects, deadlines and output limits must not change. |
| Skills and filtering | `pi-session-factory.test.ts` | Existing resource discovery/filtering is not automatically installed by Durable. Reuse or explicit sections are required; real durable skills integration was not implemented. |
| OAuth and API-key models | Factory/model-runtime tests and 9 login tests | Harness consumes pi-ai `Models`, not coding-agent `ModelRuntime`/`AgentSession`. Provider wiring and credential-refresh ownership need adaptation. Real login/refresh against Durable was not exercised. |
| Images | Factory/read-image tests | Synthetic image input and custom tool results reach the faux model. Durable's built-in `read` does not read images. Telegram channel indexing, streamed limits and real model perception were not ported/tested. |
| Documents/audio/article/market commands | Existing bot/media/provider tests | Transport and bounded conversion remain Sumire-owned; changing Harness does not remove their concurrency, cancellation or security logic. No live conversion/deployment parity is claimed. |
| Telegram/Morsel/external effects | Delivery/Morsel tests | Conservative synthetic receipt ledger works. Automatic recovery still needs durable admission metadata, uncertain-result handling and safeguards against fresh model-issued duplicate effects. |

An initial trial replacing only production pi-ai 1.0.2 with 1.0.4 failed TypeScript provider compatibility with coding-agent 1.0.2. The experiment corrected this by isolating 1.0.4 under an alias rather than casting away incompatible types or upgrading all production packages. This is an integration cost, not proof that a properly aligned Pi version set cannot work.

## Maintenance comparison

The baseline is already using an upstream agent loop. Model turns, retries, compaction and transcript persistence are not custom mechanisms available to delete a second time.

| Mechanism | Potential removal | Work that remains or is added |
|---|---|---|
| Reply-index file persistence | Temporary-file/rename writes, write tails and file snapshot cache can be replaced by commits/documents. | Alias validation, count/byte retention, chat mapping and stale checkpoint handling remain. |
| Progress reconstruction | A rewindable document can replace scanning branch tool results for the latest snapshot. | Canonical validation, context shaping, rendering, fork/reset rules and new registration remain. |
| Mutable session response capture | Submission records and immutable answer entry IDs can replace parts of shared messages/leaf capture. | Routing, concurrency at fork/reset, in-flight media invalidation and delivery-to-checkpoint linkage remain. |
| Runtime lifecycle | Durable handles interrupted generation and task checkpoints. | Opening/closing per-chat stores, coordinating reset, selecting safe work to resume and protecting external effects are new host obligations. |
| Delivery reliability | No existing native durable delivery ledger is available to remove. | Chat-wide incoming identity, atomic admission metadata, pending answer enumeration, uncertain effects, reconciliation and receipt retention are added. |

Baseline reference sizes were registry 512 lines, reply index 188, factory 167 and progress extension 89. The experiment's runtime/delivery modules were 270 lines, with simplified progress, faux models, no real capabilities and no production lifecycle integration. Those counts are **not** comparable enough to claim a net reduction or a percentage saving. The candidate demonstrates one useful replacement—upstream atomic persistence—but that minimum does not establish safe, lower-maintenance adoption of the whole bot.

The No-Go decision prioritizes the original maintenance goal over adding a new recovery feature with unresolved production safety/integration costs. It does not rule out a future migration when crash-resumable workflows themselves become a requirement.

## Verification and disposition

- Baseline: `npm ci`, 214 focused bot tests, 4 progress tests, 38 URL tool tests and 9 login tests passed (**265** total).
- Prototype: all root-required checks passed; root tests included 482 bot, 9 login, 4 progress, 283 URL content and 38 URL tool tests (**816** total, including the 24 experiment tests). The corrected counter assertion was subsequently rerun in the focused suite; the snapshot reproduces all 24 cases.
- Final tree: after removing all prototype sources/dependencies and restoring manifests/lockfile to the base, `npm ci`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` passed. Tests were 458 bot, 9 login, 4 progress, 283 URL content and 38 URL tool (**792** total).
- `changeset status` parsed the empty changeset with no package releases. `git diff` against the base confirms no source, configuration, manifest or lockfile changes. The final changes are this report and the empty changeset only.
- Snapshot signature was verified using the existing signing public key and a temporary, command-scoped allowed-signers file; Git identity and persistent signing configuration were not changed.

No-Go makes production wiring, tool-package migration, `AGENTS.md` ownership changes, release bumps, Docker candidate deployment, rollback drills and production switching **not applicable**. Their criteria were not weakened or reported as passed. Existing runtime behavior and package contracts are preserved. The PR uses an empty changeset because no package version should change.

Production state was never opened by the experiment. There are no new production transcripts, pending jobs or uncertain external operations to reconcile, and no data rollback is necessary. No package publication, version tags or release workflows were requested or dispatched.

### Conditions before reconsidering adoption

- Define and test chat-wide incoming deduplication and admission/delivery metadata across forks, crashes, reset and cancellation.
- Define a safe disposition for interrupted non-idempotent tools, including fresh model-issued retries and arbitrary `bash` effects; do not rely only on `replay: "unsafe"`.
- Validate a bounded receipt/reconciliation policy against actual Telegram/Morsel capabilities without claiming exactly-once.
- Align model/OAuth integrations and port canonical progress, skills, URL loading and media behavior, then demonstrate a net responsibility reduction under full regression tests.

### Upstream references

All evaluation claims refer to the pinned version, not moving `main`:

- [Pi Durable 1.0.4 README](https://github.com/earendil-works/pi/blob/v1.0.4/packages/durable/README.md)
- [Harness types and conversation-scoped submissions](https://github.com/earendil-works/pi/blob/v1.0.4/packages/durable/src/harness/types.ts)
- [Tool intent and safe/unsafe recovery](https://github.com/earendil-works/pi/blob/v1.0.4/packages/durable/src/harness/tool.ts)
- [SQLite Node adapter and durability settings](https://github.com/earendil-works/pi/blob/v1.0.4/packages/durable/src/storage/sqlite/node.ts)
