# @narumitw/sumire

## 0.1.1

### Patch Changes

- bde8fbb: Add an AnyDoc worker loader for public Office, OpenDocument, RTF, EPUB, and CSV URLs, with explicit AnyDoc support for remote PDFs. Preserve existing source-specific plans and route known document URLs past the built-in HTML loader. Share isolated, abortable native conversion with Telegram attachments, enforce download/output limits, and keep hosted OCR disabled.
- c0abc91: Add a dedicated Google Docs loader that exports public documents as bounded plain text while preserving tab and resource-key parameters. Route Google Docs links directly to it instead of fetching editor HTML, reject login pages and unsafe redirects, and preserve source error details.
- 07e0204: Retry Telegram polling failures at a fixed five-second interval instead of allowing exponential delays to stall recovery. Route rate-limited outage warnings, recovery messages, and fatal errors through secret-redacted logging without grammY's raw token-bearing console output.
- Updated dependencies [bde8fbb]
- Updated dependencies [c0abc91]
  - @narumitw/sumire-url-content@0.20.0
  - @narumitw/sumire-url-tool@0.2.0

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
