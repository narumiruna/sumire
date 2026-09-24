# @narumitw/sumire

## 0.4.0

### Minor Changes

- b64107b: Enable local yt-dlp and Whisper transcription for YouTube and Reels in the production image, and transcribe bounded Telegram voice and audio inputs before submitting untrusted transcript context to Pi. Canonicalize video URLs passed to yt-dlp and ignore user CLI configuration.

### Patch Changes

- f71efc8: Bundle the URL-content CLI skill as a local Pi package resource, and load it in the bot only when coding tools are enabled.
- fef1294: Remove non-visible scripts, styles, noscript blocks, and templates before generic HTML-to-Markdown conversion so bounded public URL output contains readable page content instead of page assets.
- 4e308b7: Send a pending Telegram reply before submitting to Pi, replace it with structured progress when available, and edit the same reply with the final result or cancellation.
- c635709: Keep Telegram, URL loading, delivery, and Morsel operations running when Logfire span instrumentation fails, without repeating an operation or hiding its error.
- ee957b0: Keep replies to in-flight Telegram status messages out of Pi context even when media preparation finishes after the original response.
- 8bca8e1: Load explicit `/f` source URLs concurrently before asking Pi to write the article, avoiding repeated model/tool round trips while keeping URL safety limits and publication behavior.
- 1142faf: Trace Telegram requests, Pi turns, URL loads and Morsel delivery with correlated, content-free metadata. Record Pi tool and model lifecycle events, and instruct the agent to load the current URL before answering URL-only messages.
- aa6345b: Verify Threads share links against post metadata before returning content, preserve safe loader diagnostics, and attribute Firecrawl API errors correctly.
- Updated dependencies [f71efc8]
- Updated dependencies [fef1294]
- Updated dependencies [1142faf]
- Updated dependencies [b64107b]
- Updated dependencies [aa6345b]
  - @narumitw/sumire-url-content@0.22.1
  - @narumitw/sumire-url-tool@0.3.1

## 0.3.0

### Minor Changes

- f573945: Add Frankfurter v2 daily reference mid-rates to `/t` fiat queries while retaining Bank of Taiwan cash and spot quotes for TWD pairs.

### Patch Changes

- 7746613: Load the bot system prompt from `instructions/SYSTEM.md` and move its persona to `instructions/SOUL.md`.

## 0.2.1

### Patch Changes

- f9e8c5c: Bundle the Otter expense-management skill and pinned CLI so trusted, allowlisted bot sessions can manage Otter data with an environment-provided token.

## 0.2.0

### Minor Changes

- f144782: Expand `/t` fiat exchange-rate queries to accept compact or separated currency pairs, including reverse and TWD-derived cross rates such as `TWDJPY` and `USD/JPY`.
- 7e0e03b: Add `/f` article rewriting for direct, replied, URL, image, and document input. Route the request through Pi's existing session and input pipeline, then publish the generated Taiwan Traditional Chinese article to Morsel and reply with its URL.

### Patch Changes

- 10f1f02: Include a sanitized, bounded failure reason in the Telegram notice when a required Morsel publication fails.

## 0.1.4

### Patch Changes

- be660f2: Add allowlisted exact loader selection to `load_public_url`, backed by reusable explicit URL content chains that retain public-target validation, deadlines, cancellation, admission limits, and bounded output.
- Updated dependencies [be660f2]
  - @narumitw/sumire-url-content@0.22.0
  - @narumitw/sumire-url-tool@0.3.0

## 0.1.3

### Patch Changes

- 22806b5: Bundle a `load-public-url` skill with the URL tool Pi package and bind it to direct extension-factory loads so agents, including the Sumire bot runtime, get source-aware URL-loading guidance alongside the tool.
- f4d1606: Add an explicit, allowlist-gated opt-in for Pi's `read`, `bash`, `edit`, and `write` tools in Telegram agent sessions and document their runtime security boundary.
- d416c5f: Add bounded public Threads post extraction that verifies canonical metadata and returns the decoded author and post body instead of the Threads application shell.
- c71e69b: Show the first structured progress snapshot instead of a generic pending reply, and send progress-free answers directly.
- Updated dependencies [ced9e34]
- Updated dependencies [22806b5]
- Updated dependencies [d416c5f]
  - @narumitw/sumire-url-content@0.21.0
  - @narumitw/sumire-url-tool@0.2.2

## 0.1.2

### Patch Changes

- 992a4e5: Require every Telegram text reply and edit over 1000 Unicode characters to publish its complete content to Morsel, including AI answers, commands, and progress updates. Enforce the limit regardless of rich-tool mode or higher legacy thresholds. Send only a short failure notice when publication is unavailable, without falling back to inline long text or recording a successful answer checkpoint.
- Updated dependencies [6765dcf]
  - @narumitw/sumire-progress@0.1.1
  - @narumitw/sumire-url-content@0.20.1
  - @narumitw/sumire-url-tool@0.2.1

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
