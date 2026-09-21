# @narumitw/sumire

## 0.1.0

### Minor Changes

- 2c76dfb: Add a repository-owned Pi progress package and show its structured multi-step state in the Telegram pending reply.
- 7f27042: Add the `/t` command for Yahoo Finance and Taiwan securities (including letter-suffixed TWSE/TPEX codes), MAX cryptocurrency markets, and Bank of Taiwan exchange rates. Validate candidates against listed MAX markets and fall back to Yahoo Finance for unlisted symbols or failed catalogue requests, retaining the original MAX error when an unavailable catalogue has no successful fallback. Preserve partial results and report provider outages separately from missing data, including batches with both unmatched symbols and failed requests. Keep Yahoo candle fields aligned and omit missing fields instead of backfilling from older sessions.
- 9b5f569: Add bounded Telegram document conversion and native Pi reply-tree routing. Package the safe `load_public_url` agent tool as `@narumitw/sumire-url-tool`; URL loading is agent-driven, without Telegram prefetch routing or pending URL state. Preserve finishing response checkpoints before branch navigation, reject stale submissions after reset, wait for pending reply-index writes before lookup, and hold document admission capacity from before download until child processes close, with atomic permit handoff to queued work. Make `/cancel` invalidate pending document input and suppress late results without resetting Pi history. Route `/ask` replies through the same bounded media-input pipeline so the agent receives replied document content.

### Patch Changes

- da8c738: Rename the TypeScript bot workspace and deployment service to Sumire.
- Updated dependencies [2c76dfb]
- Updated dependencies [9b5f569]
  - @narumitw/sumire-progress@0.1.0
  - @narumitw/sumire-url-tool@0.1.0
