# @narumitw/sumire

## 0.12.2

### Patch Changes

- 1823bd5: Use the shared policy resolver in the administration editor, replace the bot's legacy session representation with explicit checkpoint and passive-context operations, and share MCP revision transactions and market batch-result handling without changing external behavior.
- 5193918: Report safe, structured URL failure reasons across Telegram article loading, URL tools, and diagnostic logs. Preserve caption and audio fallback failures, confirm media duration limits from bounded metadata, and distinguish phase timeouts, missing tools, source refusal, and unknown failures without exposing upstream text or credentials.
- Updated dependencies [5193918]
  - @narumitw/sumire-url-reader@0.25.1
  - @narumitw/sumire-pi-url-reader@0.6.1

## 0.12.1

### Patch Changes

- e669516: Simplify the durable session contract, remove retired model and OAuth wiring, and share media admission control without changing Telegram or WebUI behavior.

## 0.12.0

### Minor Changes

- 2798cbf: Bundle public Polymarket tools in each bot chat's Pi Durable session, with the existing capability policy, isolated handles, replay-unsafe network execution, and client cleanup. Include the package in dependency builds and production Docker resources. Trading remains disabled.
- 2798cbf: Require Node.js 26 or newer across all workspaces. CI, release workflows, and Docker stages now use Node.js 26. Node.js versions below 26 are no longer supported.
- 6ed89a5: Remove the Miyu CNA news tool, its Telegram integration, and its workspace package.

### Patch Changes

- 3875f5d: Enable first-seen public Polymarket tools in global and default chat permissions, like other built-in tools. Preserve manual removals and explicit chat overrides.
- d99a168: Keep new Polymarket capabilities denied until administrator approval. Reject delegated Perps credentials in tool requests and show only the new-session request schema. Keep at most ten full-output files per runtime and remove them on disposal. Check the Node.js baseline only for directories with workspace manifests.
- Updated dependencies [2798cbf]
- Updated dependencies [2798cbf]
- Updated dependencies [369adbd]
- Updated dependencies [d99a168]
- Updated dependencies [c1fd21a]
  - @narumitw/sumire-pi-polymarket@0.2.0
  - @narumitw/sumire-contracts@0.3.0
  - @narumitw/sumire-policy@0.3.0
  - @narumitw/sumire-login@0.2.0
  - @narumitw/sumire-progress@0.3.0
  - @narumitw/sumire-url-reader@0.25.0
  - @narumitw/sumire-pi-url-reader@0.6.0

## 0.11.1

### Patch Changes

- 61fc250: Group tools by explicit inventory source in compact, accessible sections. Add bulk expansion controls and per-user local expansion preferences without changing permissions. Expose built-in tool metadata separately from the combined inventory.
- Updated dependencies [61fc250]
  - @narumitw/sumire-contracts@0.2.2

## 0.11.0

### Minor Changes

- 8cfb372: Add a standalone Pi CNA news tool that mentions miyuyo_bot in a host-bound Telegram group and matches its direct reply. Expose the tool only with confirmed Miyu membership, and recheck membership before sending. Connect the tool to bot startup, per-input tool refresh, authorized Telegram transport, and reply routing.

### Patch Changes

- c89e4e6: Require Miyu to be a group administrator before offering or sending plain-mention CNA news requests. Reject normal and restricted members, and document the required Telegram delivery settings.
- d684efd: Consume known Miyu replies after tool-only revocation. Defer optional membership checks until input preparation or background recovery so idle historical sessions do not delay polling startup. Include the Miyu workspace in both CI path filters.
- 0b5ad82: Stop polling intake before sending the shutdown notice. Reject queued inputs cancelled during tool refresh. Consume matching non-text and late Miyu reply parts without starting another model turn, using a bounded recent-request index.
- ae28992: Enable first-seen built-in and MCP tools in global and shared-default permissions. Preserve manual removals, explicit chat overrides, server gates, and chat access. Track registered names persistently and record automatic grants in the audit log. Keep startup available when permission lists are full. Register MCP names before authorization, but count only allowed tools against the runtime metadata limit.
- 0f18d65: Notify the configured Telegram administrator after bot startup and before graceful shutdown. Bound notification requests to five seconds and log failures without blocking the lifecycle.
- Updated dependencies [0b5ad82]
- Updated dependencies [ae28992]
- Updated dependencies [8cfb372]
  - @narumitw/sumire-pi-miyu-cna-news@0.2.0
  - @narumitw/sumire-policy@0.2.1
  - @narumitw/sumire-contracts@0.2.1

## 0.10.1

### Patch Changes

- d97aaab: Rename the URL library and CLI to `@narumitw/sumire-url-reader` and `sumire-url-reader`, and rename the Pi integration to `@narumitw/sumire-pi-url-reader`. Move both URL skills into the Pi package and resolve the CLI through its declared library dependency. Update bot imports, Docker stages, and CI paths. Keep `read_url_content`, skill names, loader behavior, and source metadata unchanged. Hosts must update package imports and use the Pi package's `urlReaderSkillsPath` instead of the former skill path exports.
- 0bd4846: Extract shared management API contracts and policy schemas and rules into private workspace packages. Remove administration frontend imports of bot source, and update dependency builds, Docker stages, and CI.
- Updated dependencies [d97aaab]
- Updated dependencies [0bd4846]
  - @narumitw/sumire-url-reader@0.24.0
  - @narumitw/sumire-pi-url-reader@0.5.0
  - @narumitw/sumire-contracts@0.2.0
  - @narumitw/sumire-policy@0.2.0

## 0.10.0

### Minor Changes

- cff5f69: Clarify administration save scopes and chat readiness, add guided MCP patch editing and redacted change previews, and provide filtered, grouped audit history with accessible controls.
  
  Keep MCP previews consistent with saved transports, clear audit errors after query recovery, and bind model-list check results to the checked endpoint settings.

### Patch Changes

- 5e2fc04: Centralize global and shared-default tool permissions with retained-selection warnings. Separate MCP connections, replace duplicate Defaults editors with saved/draft summaries, and clarify the all-chat override reset. Preserve authorization rules, drafts, legacy section links, and separate saves.
- b507a83: Extend administrator sessions to seven idle days and 30 days total, including the session cookie lifetime.

## 0.9.0

### Minor Changes

- 426f3d7: Add a Passkey-authenticated Radix administration interface with persistent chat policies, model provider management, MCP configuration, audit records, and HTTPS deployment guidance. Expose the shared bounded public-network helpers for provider requests. Add the private administrator-only `/admin` command to open the WebUI before chat approval. Use administrator-only first-passkey setup links, browser-bound WebAuthn challenges, and a state migration that revokes old Telegram sessions. Remove Telegram Web Login credentials. Add searchable provider and model setup, supported authentication dialogs, capability badges, explicit default selection, and separate custom endpoint controls. Load saved default and chat models into provider setup without promoting chat overrides to a shared default. Keep blank bind hosts on loopback, import valid MCP entries independently, use the runtime working directory for MCP probes, and apply the latest concurrent policy revision. Add revision-checked MCP deletion with confirmation and capacity recovery, block stale MCP startup after policy changes, ignore unused admin ports while the WebUI is disabled, and report unsupported imported thinking levels without failing the shared policy.
- 9f3168d: Remove environment-based chat authorization and require `BOT_ADMIN_ID` plus the SQLite administration policy for all bot admission, restored work, model access, and tools. New databases deny all chats until explicit WebUI approval. Existing permissions, revocations, Passkeys, sessions, and historical access reviews remain unchanged.
  
  This is a breaking bootstrap change for the pre-1.0 bot: `BOT_WHITELIST` is ignored, WebUI administration cannot be disabled, and Stage 1 reconciliation must be accepted before upgrade. Remove reconciliation mutation endpoints and UI controls while retaining read-only historical reports on the Audit page.
- 9f0d16c: Add `/allow` links for explicit Passkey-authenticated chat approval, with short-lived hash-only requests, atomic policy updates, and review of existing environment allowlist IDs without restoring revoked access. Upgrade administration SQLite state to schema version 3; rollback requires a matching pre-upgrade backup.

### Patch Changes

- 0ad0784: Exclude model-only and hidden tools from codemode access logs and prompt metadata with the same filter used by execution. Keep MCP discovery recovery available after a connection failure without treating missing tools as proof of missing authorization. Report MCP connection failures separately from permission limits when codemode is disabled.
- a14a8d8: Give the model each chat's authorized tool list and explain how to request missing access instead of treating skills as executable tools. Log the actual per-chat tool loadout for diagnosis.
- 39677b1: Add the Sumire GitHub repository link to the Telegram `/help` response.
- 8f94f1b: Remove Telegram model selection, thinking controls, and login commands in favor of the administration Web UI. Keep protection against pasted legacy OAuth callbacks and discard retired login command arguments before model input. Enable local passkey setup at localhost when BOT_ADMIN_ID is set and ADMIN_ORIGIN is empty. Require existing model credentials when the Web UI is unavailable.
- e9f5653: Rename the URL-reading tool from `load_public_url` to `read_url_content`. Update bot instructions, skills, documentation, and tests to use the new name. No legacy alias is registered; update direct calls, codemode scripts, and tool allowlists. Existing bot permissions are not transferred automatically: authorize the new name globally and in the effective chat policy through the Web UI.
- 83a2765: Remove the blocked reason field and preserve legacy reasons in step text, including interrupted durable calls. Show Telegram progress steps with current activity and tool names. Reuse long-message notices for activity edits, keep complete inline progress when activity does not fit, report each model turn, and enforce both grapheme and absolute text size limits.
- 82b3428: Identify model validation conflicts by settings scope and model. Add inline model warnings and a confirmed action to make all chats inherit shared defaults without changing access or enabled switches.
- 48a5fab: Share bot URL loader configuration between article preloading and Pi tools. Make YouTube caption extraction explicit in the tool description and require a current tool failure before reporting unreadable captions. Add offline caption-loading and Pi tool-loop regression tests.
- 5dfb275: Log the assembled startup instructions through the redacted logger with their hash and base tool names. Strengthen URL instructions to require current source evidence, retry after unsupported earlier claims, and disclose truncated content.
- Updated dependencies [426f3d7]
- Updated dependencies [9f3168d]
- Updated dependencies [8f94f1b]
- Updated dependencies [e9f5653]
- Updated dependencies [83a2765]
- Updated dependencies [48a5fab]
  - @narumitw/sumire-url-content@0.23.0
  - @narumitw/sumire-login@0.1.2
  - @narumitw/sumire-url-tool@0.4.0
  - @narumitw/sumire-progress@0.2.0

## 0.8.0

### Minor Changes

- a04c93d: Enable administrator-configured MCP servers by default and remove BOT_MCP_ENABLED. Disable servers through mcp.json instead; MCP configuration is now always required at startup.
- 47cedbf: Limit Bot environment configuration to BOT_TOKEN, BOT_WHITELIST, BOT_ADMIN_ID, FIRECRAWL_API_KEY, OTTER_TOKEN, LOGFIRE_TOKEN, and MORSEL_API_KEY. Ignore former runtime switches and limits in favor of fixed defaults, enable channel image input by default while preserving explicit channel authorization, and retain Docker workdir/state separation without BOT_WORKDIR. Run npm startup scripts from the repository root with only its .env file.
- fef305e: Add opt-in administrator-configured MCP tools through Pi's public MCP client, with codemode discovery, per-chat connection and process lifecycle, bounded/redacted results, and replay-unsafe durable execution. Document desktop and container Chrome requirements and provide a live production-image smoke. Enforce discovery budgets while consuming pages, reject stale wrapper generations, redact custom auth headers, and keep raw protocol definitions separate from credential-safe presentation. Bind nested tasks to selected wrapper generations, preserve result envelopes during redaction, and support empty opaque pagination cursors. Exclude skipped configurations from server-name collisions and recognize SSE media types case-insensitively while preserving per-event and non-SSE body limits. Keep notification SSE GET bodies transport-owned with bounded header waits, and normalize fractional server timeouts once to positive integer milliseconds. Release finite-response deadlines and reader locks promptly, bound configuration reads before allocation, and commit per-server redaction credentials only after full acceptance. Match credential names without arbitrary substrings, reject query credentials, and cap server names/counts to prevent metadata and connection amplification. Synchronize stale-handle regression coverage with replacement publication. Trim authorization payloads, bound and cache wildcard exposure matching, await initial discovery, enforce post-redaction metadata limits, clean abandoned process homes on recovery, and stop continuous tool-list refreshes. Bound credential counts/bytes and use a single-pass literal redactor, separate initialization from discovery deadlines, and retain cancellation through result shaping and private file writes.

### Patch Changes

- 63ec69f: Support Pi 1.1.0 tool guidelines in the durable codemode loadout and update codemode test doubles.
- 87518ea: Enable native Pi codemode in every chat session, with or without MCP servers. Remove the BOT_CODEMODE_ENABLED switch while preserving host-owned timeouts, cancellation, and model-only tool boundaries.
- 205038b: Change the default bot model to openai/gpt-6.1-sol.
- 0cbda8e: Align Docker Chromium installation with the locked Playwright version and launch Chrome MCP through an explicit headless container configuration. Use Playwright's recommended non-root Docker seccomp profile to retain Chromium's sandbox, and verify both browser paths without smoke-only argument overrides. Smoke checks select only configured default targets, tolerate customized server sets, and fail clearly for missing, disabled or invalid requested servers.
- 2536bdf: Redact decoded Basic-auth credential pairs, usernames and passwords from MCP metadata and results while preserving wire headers and enforcing existing credential budgets. Match short derived components at Unicode boundaries so unrelated schema vocabulary and result words remain intact; explicit credentials retain substring matching.
- 70fb7b4: Prevent settings UI warning floods by ignoring concurrent button clicks, skipping identical edits, honoring Telegram rate-limit cooldowns, and separating settings failures from delivery errors with metadata-only logging.
- 187c5ab: Remove the Telegram /ask command. Use mentions or replies in groups and direct messages in private chats instead.
- 1059da4: Delegate every automatic URL load to the existing url-content source selection and fallback chain, including bot tool calls and article sources. Remove built-in-first routing, warning-text matching, and host exceptions from url-tool. Keep built-in extraction as an explicit override and preserve validation, deadlines, cancellation, output bounds, and attempt metadata. Pass the host's scheme policy through the one-shot API and reusable client so local redirects cannot bypass an HTTPS-only restriction; apply the same policy to reported Firecrawl final targets.
- Updated dependencies [22bd32a]
- Updated dependencies [1059da4]
  - @narumitw/sumire-url-tool@0.3.4
  - @narumitw/sumire-url-content@0.22.4

## 0.7.0

### Minor Changes

- bf31c56: Use Pi Durable for fresh Telegram conversations with per-chat SQLite storage, persisted reply forks, progress and codemode state, and recovery of pending response delivery after restart. Preserve shared OAuth, image-capable coding tools and URL defenses; do not import legacy AgentSession transcripts or automatically replay interrupted unsafe tools. Durably order passive group context before later addressed inputs, release idle recovery-only databases, stop polling startup when shutdown interrupts recovery, and retain empty-answer and failed-turn fallback delivery until acknowledgement.

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
