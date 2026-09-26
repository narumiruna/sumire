# @narumitw/sumire-url-tool

## 0.3.3

### Patch Changes

- Updated dependencies [b0ff41f]
  - @narumitw/sumire-url-content@0.22.3

## 0.3.2

### Patch Changes

- Updated dependencies [65ad21a]
  - @narumitw/sumire-url-content@0.22.2

## 0.3.1

### Patch Changes

- fef1294: Remove non-visible scripts, styles, noscript blocks, and templates before generic HTML-to-Markdown conversion so bounded public URL output contains readable page content instead of page assets.
- 1142faf: Trace Telegram requests, Pi turns, URL loads and Morsel delivery with correlated, content-free metadata. Record Pi tool and model lifecycle events, and instruct the agent to load the current URL before answering URL-only messages.
- aa6345b: Verify Threads share links against post metadata before returning content, preserve safe loader diagnostics, and attribute Firecrawl API errors correctly.
- Updated dependencies [f71efc8]
- Updated dependencies [fef1294]
- Updated dependencies [b64107b]
- Updated dependencies [aa6345b]
  - @narumitw/sumire-url-content@0.22.1

## 0.3.0

### Minor Changes

- be660f2: Add allowlisted exact loader selection to `load_public_url`, backed by reusable explicit URL content chains that retain public-target validation, deadlines, cancellation, admission limits, and bounded output.

### Patch Changes

- Updated dependencies [be660f2]
  - @narumitw/sumire-url-content@0.22.0

## 0.2.2

### Patch Changes

- 22806b5: Bundle a `load-public-url` skill with the URL tool Pi package and bind it to direct extension-factory loads so agents, including the Sumire bot runtime, get source-aware URL-loading guidance alongside the tool.
- d416c5f: Add bounded public Threads post extraction that verifies canonical metadata and returns the decoded author and post body instead of the Threads application shell.
- Updated dependencies [ced9e34]
- Updated dependencies [d416c5f]
  - @narumitw/sumire-url-content@0.21.0

## 0.2.1

### Patch Changes

- 6765dcf: Mark all shared workspace packages as private to prevent accidental npm publication.
- Updated dependencies [6765dcf]
  - @narumitw/sumire-url-content@0.20.1

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
