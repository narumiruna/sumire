# @narumitw/sumire

## 0.6.0

### Minor Changes

- 4d9818f: Add per-chat Telegram /model and /thinking commands with paginated inline model selection, supported thinking levels, direct arguments, and Pi session restoration. Prefer exact provider/model references over colliding bare IDs and preserve current choices across reply-tree branches and restart, wait for reset cleanup before replacement-session operations, and allow authenticated non-OpenAI models to bootstrap chats. Remove Sumire-owned OPENAI_BASE_URL, OPENAI_API_KEY, and OPENAI_MODEL settings in favor of Telegram /login and /model, while leaving Pi-native credential and environment discovery unchanged.
- 41638e1: Remove OPENAI_AUTH_MODE and support API keys and shared OAuth credentials together through Pi's native OpenAI Responses provider on the official endpoint. Prefer stored credentials over the configured key, enable admin-only private /login alongside API-key use, and keep custom OpenAI-compatible endpoints API-key-only. Preserve Pi-owned persistence and refresh without silent key fallback after OAuth failure.

### Patch Changes

- a55f74f: Add opt-in native Pi codemode with a host-owned script deadline while preserving existing tool permissions, cancellation, and branch-aware state. Initialize SDK extensions before delivering a session, and keep progress and channel image reads model-only so nested orchestration cannot lose their state or image blocks.
- 5d65e55: Enable the final generic Firecrawl fallback by default for URL tool and /f source loading, and remove BOT_URL_FIRECRAWL_FALLBACK_ENABLED. The fallback still skips requests without FIRECRAWL_API_KEY or enough remaining time.
- 35ef553: Bundle checksum-verified libcurl-impersonate in the Docker image and verify Chrome fingerprint compatibility offline so URL loading no longer uses unsupported system libcurl impersonation.
- 7d2c960: Explain only the unmet Telegram /login conditions in the running bot's settings. Distinguish custom endpoints, missing explicit admin whitelist entries, and an unavailable login service despite eligible settings without exposing endpoint values or credentials.
- Updated dependencies [a55f74f]
  - @narumitw/sumire-progress@0.1.3

## 0.5.0

### Minor Changes

- 9011460: Index new images from explicitly allowlisted Telegram channels without starting Pi or posting to the channel. Add an opt-in `read_image` tool so Pi can list and read indexed channel images on demand during authorized conversations.
- a0dd83e: Add a reusable Pi OAuth login package and an admin-only private Telegram `/login`. Support shared OpenAI subscription authentication through Pi's native Responses provider, with persistent credentials, cancellation, timeout, and authentication input interception. Preserve the existing API-key/OpenAI-compatible mode.

### Patch Changes

- 4836744: Add an optional Telegram admin user ID, expose the sender role to Pi per message, and show admin status in `/id`.
- d914527: Prevent slow URL attempts from starving automatic fallback, prefer fast browser extraction, and share a total deadline across validation and built-in/source-aware loading. Article preloading now uses its configured budget and displays a reusable status before fetching. Preserve safe timeout/cancellation diagnostics and bound cleanup waiting. Add an opt-in final Firecrawl fallback, with streamed response limits and reported-target validation, without enabling external costs merely because an API key exists.
- 420d4df: Reuse independent workspace build layers and npm, pip, and apt download caches in Docker builds. Isolate Chromium downloads and torch installation, exclude test inputs from the build context, and persist intermediate container build layers in GitHub Actions cache.
- b0ff41f: Avoid initializing impers while loading shared URL loaders, and provide system libcurl in the Docker image without relying on a runtime download.
- 04beab6: Keep group passive context before the next user turn and disable Logfire's HTTP auto-instrumentation so raw request URLs cannot leak the Telegram bot token into traces.
- b40c95a: Keep typebox in the production image and smoke-test bot startup imports during the Docker build.
- 76a74e4: Install Git, OpenSSH client tools, and CA certificates in the bot runtime image so coding tools can clone repositories and generate SSH keys. Verify tool availability as the non-root bot user during the image build.
- caba261: Show every reported progress step, including completed ones, and keep the last snapshot alongside the final Telegram answer.
- a4443be: Run Pi tools and the bot user home in a dedicated `/workdir` volume so image-managed code under `/app` updates on rebuild.
- 5b7a634: Update Pi dependencies to 0.99.1, Vitest to 5.0.3, taiwan-exchange-rates to 0.2.1, and fast-xml-parser to 5.11.2, and refresh the dependency lockfile. Align the bot's session interface with Pi's steering and follow-up return types.
- 93b032c: Update Pi dependencies to 1.0.0, Biome to 2.5.15, and Node.js type definitions to 26.6.4, and refresh the dependency lockfile.
- 2709cfb: Update Pi dependencies to 1.0.2 across all workspaces, update the bot's Otter CLI to 0.3.1 and Logfire Node to 0.18.27, and refresh the dependency lockfile.
- 5cb94f8: Update Pi and other workspace dependencies, including the dependency lockfile.
- Updated dependencies [d914527]
- Updated dependencies [b0ff41f]
- Updated dependencies [b40c95a]
- Updated dependencies [a0dd83e]
- Updated dependencies [5b7a634]
- Updated dependencies [93b032c]
- Updated dependencies [2709cfb]
- Updated dependencies [5cb94f8]
  - @narumitw/sumire-url-content@0.22.3
  - @narumitw/sumire-url-tool@0.3.3
  - @narumitw/sumire-progress@0.1.2
  - @narumitw/sumire-login@0.1.1

## 0.4.1

### Patch Changes

- 65ad21a: Enable Pi's native read, bash, edit, and write tools in every bot session, remove the coding-tool opt-in flag, and require a non-empty Telegram whitelist before starting sessions. Make the URL-content CLI skill available by default.
- cb6d47c: Show Pi model and tool activity in the Telegram pending reply when no structured progress has been published, while keeping structured progress visible when available.
- Updated dependencies [65ad21a]
  - @narumitw/sumire-url-content@0.22.2
  - @narumitw/sumire-url-tool@0.3.2

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
