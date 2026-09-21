# @narumitw/sumire-url-tool

## 0.2.0

### Minor Changes

- bde8fbb: Add an AnyDoc worker loader for public Office, OpenDocument, RTF, EPUB, and CSV URLs, with explicit AnyDoc support for remote PDFs. Preserve existing source-specific plans and route known document URLs past the built-in HTML loader. Share isolated, abortable native conversion with Telegram attachments, enforce download/output limits, and keep hosted OCR disabled.

### Patch Changes

- c0abc91: Add a dedicated Google Docs loader that exports public documents as bounded plain text while preserving tab and resource-key parameters. Route Google Docs links directly to it instead of fetching editor HTML, reject login pages and unsafe redirects, and preserve source error details.
- Updated dependencies [bde8fbb]
- Updated dependencies [c0abc91]
  - @narumitw/sumire-url-content@0.20.0

## 0.1.0

### Minor Changes

- 9b5f569: Add bounded Telegram document conversion and native Pi reply-tree routing. Package the safe `load_public_url` agent tool as `@narumitw/sumire-url-tool`; URL loading is agent-driven, without Telegram prefetch routing or pending URL state. Preserve finishing response checkpoints before branch navigation, reject stale submissions after reset, wait for pending reply-index writes before lookup, and hold document admission capacity from before download until child processes close, with atomic permit handoff to queued work. Make `/cancel` invalidate pending document input and suppress late results without resetting Pi history. Route `/ask` replies through the same bounded media-input pipeline so the agent receives replied document content.

### Patch Changes

- Updated dependencies [3781f36]
  - @narumitw/sumire-url-content@0.19.7
