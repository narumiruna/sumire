# Sumire

Sumire's Telegram bot service, built on Pi and isolated under `./apps/bot`.

## Runtime stack

- `@earendil-works/pi-durable` and `@earendil-works/chord`: persistent conversations, generation/tool tasks, retries, compaction, steering, follow-up, forks, cancellation, and recovery.
- `@earendil-works/pi-coding-agent`: shared ModelRuntime/OAuth, Agent Skills discovery, image-capable coding tools, and the native codemode sandbox; the bot does not create an AgentSession.
- `@earendil-works/pi-agent-core`: official agent message and event contracts.
- `@earendil-works/pi-ai`: provider/model and media primitives.
- `@narumitw/sumire-login`: repository-owned Pi package for UI-neutral OAuth login.
- `@narumitw/sumire-progress`: repository-owned Pi package for structured multi-step progress.
- `@narumitw/sumire-url-tool`: repository-owned Pi package for agent-driven public URL loading.
- grammY: Telegram Bot API.
- Biome: formatting and linting.
- `@firecrawl/anydoc`: isolated local document-to-Markdown conversion without hosted OCR.
- `@narumitw/otter-cli`: non-interactive Otter expense management used by the bundled Agent Skill.
- Vitest: tests.

There is no custom agent loop and no Vercel AI SDK. Telegram code owns only update routing and the mapping from Telegram chat IDs to Pi sessions.

## Current implementation

Available now:

- private chat and group mention/reply routing
- opt-in, on-demand reading of newly indexed images from allowlisted Telegram channels via Pi's `read_image` tool
- allowlist and bot-loop limits
- `/start`, `/help`, `/id`, `/f`, `/model`, `/thinking`, `/cancel`, and `/reset`
- admin-only private `/login` for a shared OpenAI subscription account, with credentials resolved by Pi
- `/f` article rewriting and Morsel publication in Taiwan Traditional Chinese
- `/t` market-data queries for Yahoo Finance stocks/crypto, TWSE stocks, MAX crypto pairs, Frankfurter reference rates, and Bank of Taiwan TWD quotes
- isolated Pi Durable SQLite storage per Telegram chat, with restart recovery
- Pi-managed retry, compaction, steering, follow-up, abort, tool loop, and persistence
- Pi's native `read`, `bash`, `edit`, and `write` coding tools in every chat session
- default Pi codemode for JavaScript tool orchestration with a host-owned deadline
- `instructions/SYSTEM.md`, `instructions/SOUL.md`, and filtered Agent Skills, including Otter expense management
- bounded Telegram image, document, and locally transcribed voice/audio input
- durable conversation forks when users reply to earlier completed bot output
- public HTTP(S)-only URL loading as a Pi tool, with bounded built-in extraction and source-aware URL content fallback
- Morsel rich-rendering tool and mandatory routing for messages over 1000 characters
- live multi-step progress as the first Telegram reply
- Telegram HTML rendering with a 1000-character inline message limit
- secret-redacted logs

## Requirements

- Node.js 22.19 or newer
- Linux x86_64 with glibc for the production AnyDoc native adapter
- Telegram bot token
- OpenAI subscription login through Telegram `/login`, or credentials already available to Pi
- Playwright Chromium for source-aware browser fallbacks
- Git and OpenSSH client tools (`ssh`, `ssh-keygen`) for repository cloning and SSH key generation outside Docker

## Install and run

From the repository root:

```bash
cp .env.example .env
cd apps/bot
npm install
npx playwright install chromium
npm run build
npm start
```

The scripts load `../../.env` first and then `./.env` as an optional override. Paths such as `instructions`, `skills`, and `.telegramagent` resolve against the repository root. Pi tools use that root as their working directory locally unless `BOT_WORKDIR` is set. The system prompt is rendered from `instructions/SYSTEM.md`, which must contain exactly one `{{SOUL_SECTION}}` placeholder for `instructions/SOUL.md`. Skills are always loaded from `./skills`.

For development:

```bash
cd apps/bot
npm run dev -- --verbose
```

To use the `otter-manage-expenses` skill, set `OTTER_TOKEN` through the ignored `.env` or another deployment secret mechanism.
The upstream skill runs the bundled `otter` CLI through Pi's shell tool, so configure a `BOT_WHITELIST` containing only trusted users or chats before exposing the bot.
Do not commit the token.

## Article command

Use `/f <內容>` to reorganize text into a coherent Markdown article in Taiwan Traditional Chinese. A bare `/f` can reply to a text message, public URL, image, or supported document. Reply and media inputs use the same bounded context assembly, feature controls, submission ordering, cancellation, and reply-tree restoration as ordinary Pi requests. For `/f`, up to four distinct URLs explicitly present in the command or replied message are loaded concurrently with the bounded public URL loader before the article is submitted to Pi; the combined extracted content is capped by `BOT_URL_MAX_EXTRACTED_CHARS` and all sources share `BOT_URL_CONTENT_TIMEOUT_SECONDS` as their deadline (default 180 seconds, with no hidden 30-second cap). A `正在載入文章來源…` status appears before URL loading and is reused for Pi progress and final delivery; failure or cancellation replaces that status. If any source URL fails or the configured character budget is too small for the number of URLs, `/f` reports the failure without publishing an incomplete article. Cancellation stops in-flight loads. Pi writes the article from the loaded, untrusted source context without reloading those URLs. Ordinary requests remain agent-driven and use `load_public_url`; Telegram does not prefetch them.

The blog post request preserves material information, forbids new facts, uses specific emoji section headings, and limits each section to 1,000 characters and the complete article to fewer than 5,000 characters. Sumire publishes every successful `/f` result to Morsel and replies to the triggering message with only the article URL. `MORSEL_API_KEY` is therefore required for `/f`; if publication is unavailable, Sumire withholds the generated article and returns a short error.

## Market-data command

Use `/t` with one or more whitespace- or comma-separated symbols:

```text
/t AAPL          # Yahoo Finance stock
/t 2330          # TWSE/TPEX stock
/t 00980A        # TWSE active ETF
/t 2881A         # TWSE preferred share
/t BTC-USD       # Yahoo Finance cryptocurrency pair
/t BTCUSDT       # MAX Exchange cryptocurrency pair
/t USD           # Frankfurter USD/TWD reference rate and Bank of Taiwan quotes
/t JPY/TWD       # Frankfurter JPY/TWD reference rate and Bank of Taiwan quotes
/t TWDJPY        # Frankfurter TWD/JPY reference rate and reversed Bank of Taiwan quotes
/t USD/JPY       # Frankfurter USD/JPY reference rate
```

A request accepts at most 10 unique symbols. Bare supported three-letter currencies are treated as foreign-currency queries against TWD. Supported fiat pairs can be written as `TWDJPY`, `TWD/JPY`, `TWD-JPY`, or `TWD_JPY`. Every fiat query returns the Frankfurter v2 daily reference mid-rate. Pairs involving TWD also return Bank of Taiwan spot and cash quotes; reversed TWD pairs are calculated from the bank's published quote and clearly marked. MAX-like suffixes are matched against the MAX markets catalogue; symbols absent from that catalogue (such as `GBTC`) fall back to Yahoo Finance. If the catalogue request fails, candidates still try Yahoo; the original MAX error is retained when no fallback returns data. Failures querying listed MAX markets are not retried through Yahoo.

Yahoo candle fields use the latest candle position; missing fields are omitted rather than carried forward from an older session.

## Quality gates

```bash
cd apps/bot
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Apply Biome formatting and safe fixes with:

```bash
npm run check:write
```

## Session storage

Every chat starts with Pi Durable. Legacy AgentSession JSONL files are neither imported nor continued; upgrading starts a fresh conversation without deleting those files.

```text
.telegramagent/sessions/<chat-id>/durable/session.sqlite
.telegramagent/sessions/<chat-id>/telegram-reply-index.json
```

The Harness owns generation, tool scheduling, retries, compaction, and storage. The bot stores a stable chat-session identity, the selected conversation fork, branch-aware progress/codemode documents, and pending response delivery metadata. SQLite uses WAL mode with `synchronous=NORMAL`: process crashes are recoverable, but the newest commits may be lost on power or host failure. Each database belongs to one bot process; do not run multiple replicas against the same state directory. Compose persists it in the existing `state` volume under `/app/.telegramagent`; tools still work in `/workdir`.

On startup, the bot reopens durable chat databases and resumes admitted work. Pending primary responses retain their source message ID, status message ID, and delivery mode, so a recovered answer replaces the saved status through the normal bounded Telegram/Morsel delivery path. Successfully delivered responses are acknowledged even when reply-tree routing is disabled. Failed deliveries stay pending for the next restart. Missing model credentials defer recovery; after provisioning credentials, restart to retry automatic delivery. Changing `BOT_WHITELIST` cancels all previously pending work before any task resumes, even when the change only adds an ID.

Graceful shutdown closes storage without withdrawing admitted work. `/cancel` explicitly withdraws inputs and aborts work; `/reset` additionally deletes the chat's durable storage, legacy Pi directory, and reply index. Interrupted mutations, Bash, URL requests, Morsel publication, codemode scripts, and nested codemode calls are **not replayed automatically**: Pi receives an interrupted-tool error and decides how to continue. Local reads and progress updates are replay-safe. Side effects are not rolled back; a model may choose to issue a new call, so inspect effects before retrying sensitive work.

Telegram sends and local commits are not atomic. Recovery prefers editing the same saved status, but a crash after sending a replacement message or publishing to Morsel and before acknowledgement can duplicate delivery/publication. Recovery does not reconstruct the old live progress editor or preserve its retained-progress layout; the committed progress state remains available to the model. Media download, document conversion, audio transcription, and article URL preloading are not durable until their prepared input is admitted.

After delivery, the bounded reply index maps Telegram message IDs to the durable session/entry checkpoint. Replying to an earlier answer forks its source conversation at that entry and persists the new active fork, without an abandoned-branch summary. Unknown, legacy, evicted, or disabled mappings continue from the current conversation and retain ordinary quoted reply context. Unaddressed group messages remain untrusted passive context: they are admitted as durable writes without starting or steering a turn, then placed at the next boundary before later addressed inputs. Only recent passive messages are carried to a restored reply branch.

Startup recovery closes idle historical chat databases before opening the next one and releases recovery-only sessions after their final delivery is acknowledged. Sessions adopted by live updates and outstanding delivery intents remain available. Shutdown during recovery does not start a new poller. Empty model answers and failed turns retain their saved delivery intent until the fallback reply is delivered and acknowledged. Recovery reuses a failed request's terminal submission without retrying the model; `/cancel` and `/reset` explicitly withdraw its pending fallback.

The durable API is experimental and pinned to 1.0.2 alongside the other Pi packages. Upgrade them deliberately and re-run recovery, unsafe-tool, codemode, and fork tests. Before deployment, stop the old bot, back up the state volume, then run `docker compose up -d --build sumire`. To roll back, stop the bot and restore the previous image; keep the state volume and never use `docker compose down -v`. The old runtime cannot read durable databases and will use its legacy transcripts instead. Automated tests cover offline provider requests, process kill/reopen, unsafe-call interruption, and mocked Telegram recovery; live provider/Telegram delivery and the Linux production image still require deployment verification.

## Model configuration

`.env.example` lists Sumire's supported environment configuration. Sumire does not parse or apply `OPENAI_BASE_URL`, `OPENAI_API_KEY`, or `OPENAI_MODEL`, and does not register an environment-configured OpenAI-compatible provider. Use Telegram `/login` for the shared OpenAI account and `/model` for each chat's model. New chats prefer Pi's native `openai/gpt-5.6-luna` model when authenticated, otherwise use an authenticated Pi chat model; existing chats restore their saved choice when available.

Explicitly listing `BOT_ADMIN_ID` in `BOT_WHITELIST` enables admin-only private `/login` and lets the bot start before first login. Without an authorized login admin, startup requires credentials available to Pi. Pi owns credential discovery, precedence, and refresh. Sumire neither overrides nor removes process environment values: credentials or provider environment settings independently consumed by Pi remain Pi's responsibility. Pi's stored OAuth credentials take priority over ambient API keys, and refresh failure does not silently fall back to a key.

The bounded public URL loader and structured progress tool are always enabled. Pi's native `read`, `bash`, `edit`, and `write` coding tools are enabled for every session, alongside the progress and URL extension tools. Set a non-empty `BOT_WHITELIST=<trusted Telegram user ID>` in the ignored root `.env`, then restart the bot (`docker compose up -d --build sumire` for Compose). Startup fails if the whitelist is empty. A group chat ID allows anyone who can address the bot in that group to use the tools, so prefer trusted user IDs. Optionally set `BOT_ADMIN_ID=<Telegram user ID>` (find it with `/id`): `/id` then reports `is_admin`, and Pi receives a per-message sender role based on Telegram's `from.id`, not the chat ID or user-supplied text. Anonymous group messages are not treated as admin. This is identity context, **not** an access-control boundary: `BOT_WHITELIST` still controls who can use the bot's existing tools. A future GitHub PR capability must enforce admin-only access in code against the authenticated sender ID; the role text in the prompt cannot authorize actions, and allowlisted users currently have access to `bash`. Morsel is enabled when `MORSEL_API_KEY` is configured and is required for `/f` article publication and replies over 1,000 characters. After input preparation, the bot sends a `處理中…` reply before submitting to Pi; `/f` URL preloading instead creates its status before fetching and reuses it for the model turn. Pi execution events update the reply with model/tool activity even when the model does not call `update_progress`; generic activity edits are limited to one every two seconds, with the latest status retained. Non-empty `update_progress` snapshots show every reported step in order, including completed steps, instead of generic activity; clearing progress restores `處理中…` while the model works. After a completed answer, the last successfully displayed non-empty snapshot from that submission remains visible in the original reply, with a separate final answer; if a later update fails, the bot restores the earlier snapshot (reusing its Morsel link if necessary). If the model cleared progress, the retained snapshot is labeled `最後回報的進度（已清除）` unless that label alone would exceed the Telegram inline limit; in that case the full snapshot is kept without the label. Neither version implies every step finished. The bot does not invent steps or completion statuses. If no progress was successfully displayed, or the turn is cancelled or fails, the status is replaced by the result as before. After successful delivery, replies to either retained progress or the final answer restore the same answer branch. If editing the status or sending the final answer fails, the bot uses its existing fallback or error handling. Replies to an in-flight status do not quote its synthetic content to Pi, even if the status completes while their attachments are being prepared. Replies to an already displayed final answer retain their reply-tree context even before Telegram acknowledges the edit. Input validation, downloads, and transcription happen before the model pending reply; article-source loading has its own early status as described above.

The coding tools run with the bot process's filesystem permissions and Pi's configured working directory; Sumire does not restrict tool paths, and `bash` inherits the process environment, including `OTTER_TOKEN`. In Compose, the bot runs image-managed code from `/app` while its working directory and home are `/workdir`, backed by the `workdir` named volume. Files created with relative paths and `~/.ssh` live in `/workdir`; the former `sumire_workdir` volume has been removed, so old SSH keys require an external backup or regeneration. The image does not contain the host repository's source tree; mounted `/app/instructions` and `/app/skills` are read-only. The container is not a tool sandbox: tools can still use absolute `/app` paths. Restrict `BOT_WHITELIST` to trusted users or chats before deployment.

The repository vendors the reviewed `otter-manage-expenses` skill from [narumiruna/otter](https://github.com/narumiruna/otter) and installs `@narumitw/otter-cli` as a pinned runtime dependency. The production image adds its npm binary directory to `PATH`; Compose passes `OTTER_TOKEN` from the ignored root `.env` without copying it into the image.

## Model and thinking commands

`/model` shows the current model and a paginated inline picker of authenticated Pi chat models. Select a button or send `/model <provider/model>`; an unambiguous model ID also works. The picker uses Pi's available chat models and credential checks. Selecting a model does not invoke a model turn.

`/thinking` shows the current thinking level and only the levels supported by the selected model. Select a button or send `/thinking <level>` (for example, `/thinking high`). Unsupported levels are rejected rather than silently clamped. Models without reasoning support offer only `off`; Pi adjusts the thinking level to the new model's capabilities when switching models.

Both commands use the existing `BOT_WHITELIST` rules, including for button callbacks. Choices apply to the **chat**, not individual users in a group, and do not change defaults for other chats. Changes are rejected while Pi is busy; wait for completion or use `/cancel` first. Commands received during `/reset` wait until its cleanup finishes before creating or changing the replacement session. Pi records choices on the current session branch and restores them after restart once that session contains a conversation message. Replying to an older bot message carries the current model and thinking choices onto the restored branch, so they also survive restart. Before the first conversation message, Pi keeps setup-only changes in memory. `/reset` clears the chat's conversation and choices, returning to the authenticated startup model and its supported equivalent of `off`. If a saved model is missing or no longer authenticated, `openai/gpt-5.6-luna` is preferred when authenticated, otherwise another authenticated Pi chat model is used.

The bot registers `/model` and `/thinking` in Telegram's command menu at startup and subscribes to `callback_query` updates in addition to message updates. Menu-registration failures are logged without stopping polling.

## Codemode

Pi's native `codemode` tool is enabled in every session, with or without MCP servers. No enable environment variable is required; the removed `BOT_CODEMODE_ENABLED` setting is ignored. Sumire uses `mode: "on"`, so existing tools remain directly available. Codemode does not enable `tool_search`, classifier models, or image generation. The script's `models` namespace is unavailable.

Scripts run in Pi's QuickJS sandbox with no Node APIs, filesystem, network, or timers. They can reach registered callable tools through `tools.<name>(args)`, use `Promise.allSettled()` for independent calls, and filter results before returning them to the model. Only output explicitly returned or emitted by the script reaches the model; nested results are not independent transcript messages. Do not run dependent writes or publication operations in parallel. `store()` holds small JSON values on the current Pi branch and survives session reload; chat stores are isolated, but coding-tool filesystem access still uses the shared Bot workdir.

`BOT_CODEMODE_TIMEOUT_SECONDS` defaults to 300 and accepts 0.1–3,600 seconds. The host starts this deadline for each script, including nested tool work, and combines it with Pi's cancellation signal. A script's `// @options:` may shorten its deadline but cannot extend the host limit. The deadline does not cover model requests or the whole conversation turn. Abort-aware tools begin cancellation at expiry; cleanup may outlast the deadline. `/cancel` and `/reset` use the existing Pi cancellation path. Errors, timeouts, and cancellation do **not** undo completed file modifications, network requests, or publication. Inspect side effects before retrying a failed script; do not assume it is safe to replay.

Pi's existing bounds remain in place: a 256 MB VM heap, output truncation with a default 10,000 estimated tokens and full text saved to a temporary file, and a hard output ceiling of 16,777,216 characters of text plus base64 data or 100,000 output calls. Scripts may change the token truncation budget through Pi's options but not bypass its hard ceilings. Sumire does not create another VM or agent loop.

`update_progress` and `read_image` are model-only tools: Pi calls them directly, never from a script. Direct progress snapshots remain reconstructable across compaction, restart, and reply-tree navigation; direct image reads keep their image blocks. For images read through native `read`, use a direct call too: nested tools without an output schema provide only text to the script. `load_public_url` keeps its existing result contract and URL defenses; it returns JSON text, so scripts can use `JSON.parse(await tools.load_public_url({ url }))`. Native `bash` returns a structured result; `read`, `edit`, and `write` return text.

Codemode does not grant new permissions or make `bash` safe for untrusted users. The existing non-empty `BOT_WHITELIST` remains required, and all callable tools retain validation and durable task ownership. Nested URL loads still reject credentials, local/private/link-local/metadata targets and unsafe redirects, with their existing byte, time and output limits. Tool output and fetched content remain untrusted data, not authorization.

Codemode has no runtime disable switch. To roll back this change, restore the previous bot image and configuration while keeping the state volumes; do not use `docker compose down -v`. Endpoint/model support and real Telegram delivery require deployment-specific verification.

Run the isolated Linux x86_64 production-runtime smoke from the repository root:

```bash
docker compose -p sumire-codemode-smoke -f compose.codemode-smoke.yaml run --build --rm sumire
docker compose -p sumire-codemode-smoke -f compose.codemode-smoke.yaml down
```

This uses a separate image, no `.env` or state volumes, and disabled container networking. Its loopback Chat Completions fixture verifies the pruned production worker/WASM, native tools, direct progress, persistence, host deadline and recovery without provider charges or Telegram polling. It does not replace a live endpoint/Telegram test.

## MCP servers

MCP is enabled by default: Sumire always loads the administrator-owned `mcp.json` at startup. No enable environment variable is required. Codemode is available independently of MCP configuration. Set `enabled: false` on individual servers to disable them; use `{"mcpServers": {}}` to disable all MCP connections and subprocesses. Restart after configuration changes.

`BOT_MCP_CONFIG_PATH` defaults to `<application root>/mcp.json`, independently of `BOT_WORKDIR`. Compose mounts the root `mcp.json` read-only at `/app/mcp.json`. Configurations support at most 16 total server entries (including disabled entries); exceeding this limit fails before expansion or connections. Server names must contain 1–64 ASCII letters, digits, underscores or hyphens; oversized names are skipped. Each server supports at most 64 combined environment/header fields and 64 exposure patterns of up to 128 characters; excess entries are skipped. Each derived credential is limited to 4,096 UTF-8 bytes. Per-entry credential overflow skips that entry; more than 128 distinct credentials or 32,768 credential bytes across accepted servers fails startup. Redaction compiles bounded literal alternatives once and replaces matches in one pass without rescanning replacement markers. Wildcards use cached literal segments, not regular expressions. Only this administrator-selected file is loaded: Sumire does not merge home or workdir MCP configuration or discover arbitrary extensions. The loader requires a regular file and reads at most 1 MB plus one overflow byte, including files that grow during reading. Missing/unreadable files, oversized configuration (over 1 MB), invalid JSON and invalid top-level shape fail startup. Invalid individual servers, missing environment variables and failed connections are skipped without disabling healthy servers. Diagnostics omit values and server stderr to avoid leaking secrets. Opening remains pending through initial discovery, even if transport initialization has finished. Its initialization timer is cleared on successful connection; directory discovery retains its separate ten-second request budget. Continuous tool-change notifications are limited to eight consecutive refreshes; exceeding the limit closes that connection without background retries. Before creating process homes, the chat's single process owner removes abandoned reserved `process-*` directories once; persisted results and active in-process homes are preserved. Correct configuration and restart to reload; there is no Telegram `/mcp` UI.

The tracked configuration contains:

- `chrome-devtools`: `npx -y chrome-devtools-mcp@latest` over stdio. This requires npm network access and an installed Chrome. `@latest` is deliberately unpinned as requested; production deployments can choose a separately configured pinned version.
- `firecrawl`: `https://mcp.firecrawl.dev/v2/mcp` over Streamable HTTP, with `Authorization: Bearer ${FIRECRAWL_API_KEY}`. Set `FIRECRAWL_API_KEY` in the ignored `.env`, not JSON. Missing variables disable that server; placeholders are never sent literally.

Servers support `command`/`args`/`cwd`/`env` for stdio, or `url`/`headers` for HTTP, plus `description`, `enabled`, `timeout`, `exposure` and `toolExposure`. Legacy SSE, OAuth, credential `!command` expansion, unknown fields and `deferred` exposure are rejected. `${NAME}` interpolation applies to `env` and `headers`. Use `codemode` (default), `direct` or `hidden` exposure; `toolExposure` supports exact names and ordered `*` patterns, with exact matches taking precedence. This release does not expose MCP resources, resource templates, prompts, sampling or tasks.

The Pi-owned `Harness` remains the only agent runtime. Sumire uses the public `@earendil-works/pi-mcp` client as a tool capability, without private Pi imports, another model loop or a session storage migration. Codemode tools are not declared directly or enumerated in the codemode description. Scripts discover them using asynchronous `searchTools()`, `describeTool()` and `describeNamespace()`, or `ALL_TOOLS`:

```javascript
text(await searchTools("scrape", { namespace: "firecrawl" }))
text(await describeNamespace("firecrawl"))
```

Tool names follow `mcp__<server>__<tool>` normalization and deterministic hash suffixes for collisions/long names. Identifiers containing configured credentials use opaque hash aliases while dispatch retains the raw protocol name. Tool-list changes update the next discovery and model request; stale wrapper generations are rejected even when a replacement has the same normalized name. Codemode snapshots bind nested durable tasks to the selected wrapper generation; a retained script handle cannot invoke a replacement method. Missing or unverifiable generations fail closed after restart. Each chat owns separate connections, subprocess homes and Chrome profiles. Stdio processes inherit only essential system variables and explicitly configured server `env`, not bot tokens or unrelated API keys. Explicit remote browser connections or fixed `--userDataDir` arguments can bypass profile isolation: do not configure them for multiple chats. The existing workdir and filesystem permissions are still shared, not sandboxed.

Startup/discovery waits up to 10 seconds; connections may complete in the background. Initialization is bounded by the lesser of the server timeout and 60 seconds, and tool discovery by 10 seconds, 1,024 tools and 8 MB of cumulative page metadata. Discovery stops before fetching another page once a bound is exceeded; repeated cursors and duplicate raw tool names are rejected. Empty strings are valid opaque cursors; only null or absent cursors end discovery. A disconnected connection reconnects on the next codemode discovery. Each call has an absolute `timeout` (default 60 seconds, maximum 3,600), combined with `/cancel` and the codemode host deadline. Fractional seconds are rounded up once to positive integer milliseconds. Finite HTTP responses release deadline timers/listeners on EOF, cancellation or read failure; bodyless responses release them immediately. HTTP GET header waits remain bounded; successful SSE GET bodies use the transport-owned lifetime and cancellation instead of a request deadline, while retaining Pi's per-event byte limit. POST responses and GET error/non-SSE bodies retain their request deadlines. Requests are not resent after failure or process restart: all MCP executions are replay-unsafe durable tasks. Interrupted calls require inspecting external side effects before explicitly retrying. Shutdown closes connections and terminates stdio process groups, including descendants after an unexpected leader exit.

Codemode receives a bounded MCP result with `content`, optional `structuredContent` and `isError`; protocol `_meta` fields are omitted before redaction. Protocol envelope keys and content discriminants remain unchanged; only payload data is redacted. Binary bytes and MIME metadata are never rewritten; credential matches fail the call instead of returning corrupted or sensitive content. Scripts must inspect `isError` because error results resolve rather than throw. Direct calls are marked as failed. Text reaches the model with a 20 KB per-block preview; full text is saved privately beneath the chat's `durable/mcp/results/` directory. Caller cancellation and the absolute call deadline stay active through shaping and signal-aware writes; checks surround non-abortable directory/open/close operations and precede delivery. Files created by failed or cancelled shaping are removed. Raw script results and HTTP JSON bodies/SSE events/stdio messages are limited to 8 MB; individual image and embedded binary blocks are limited to 2 MB. Audio and resource links appear as text placeholders to the model but remain in the raw script result. Accepted servers' configured credential values, including literal custom auth headers, are redacted from metadata and results before persistence. Canonical Base64/UTF-8 Basic-auth pairs and their nonempty username/password components are also recorded. Derived components of up to three Unicode code points match only when adjacent characters are not Unicode letters, marks, numbers or underscores; standalone echoes are redacted without matching unrelated words such as `object` for password `b`. Longer components and full decoded pairs retain literal substring matching. An explicitly configured credential always retains substring matching even when it is also a short derived component. Embedded short-component echoes inside word-like strings are not redacted; boundary matching is not a general secret-detection guarantee. Credentials collected from invalid, disabled or colliding entries are discarded rather than changing healthy servers' metadata. Literal credential names use delimited/camel-case words and explicit combined forms, not arbitrary substrings such as `MONKEY` or `AUTHOR`; `${NAME}` interpolation always marks the substituted value for redaction. Known credential-bearing URL query parameters are rejected; supply authentication through configured headers or environment values instead. Raw tool definitions remain private and unmodified. Schema descriptions are redacted and credential-bearing defaults/examples omitted; tools whose structural schema keys, enum/const values or references contain credentials are withheld rather than corrupting validation semantics or exposing secrets. Rotate such credentials or change the server schema to make those tools available. After redaction, namespace prose and schema descriptions are limited to 4,096 characters; namespace metadata is shared across wrappers. Annotations over 4,096 serialized bytes are omitted, and cumulative published metadata stays within 8 MB per server by withholding excess tools. Redaction cannot prevent secrets supplied directly in user/model inputs or accessed through existing coding tools. Result files and session storage require normal disk monitoring and private backups.

### Chrome in Docker and live verification

The requested root configuration is a desktop example, not a headless Docker browser configuration. For Docker, use a separate administrator config to add `--headless`, `--isolated`, `--executablePath <installed Chromium path>` and optionally `--no-usage-statistics`/`--no-performance-crux`. The executable path varies by Playwright version and architecture; the smoke script locates it. Do not disable Chrome's sandbox, enable privileged containers or connect to a personal browser to make a smoke pass.

Run from the repository root with `FIRECRAWL_API_KEY` exported in the shell:

```bash
docker compose -p sumire-mcp-validation -f compose.mcp-smoke.yaml build mcp-smoke
docker compose -p sumire-mcp-validation -f compose.mcp-smoke.yaml run --rm mcp-smoke
# Independently verify one low-cost Firecrawl search if Chrome cannot start:
docker compose -p sumire-mcp-validation -f compose.mcp-smoke.yaml run --rm mcp-smoke --firecrawl-only
docker compose -p sumire-mcp-validation -f compose.mcp-smoke.yaml down
```

This uses the production image with separate ephemeral state and no Telegram polling. The full smoke opens `https://example.com`, reads a snapshot, captures an image and performs one Firecrawl search (`limit=1`, may consume credits). Do not print credentials or search content as evidence. On the current Linux ARM64 Docker environment, the image builds and Firecrawl smoke passes, but Chromium reports `No usable sandbox`; the full Chrome smoke remains blocked pending a sandbox-capable deployment. No sandbox bypass is configured.

MCP is additional administrator-authorized capability, not a replacement for `load_public_url` or its public-target/redirect/byte-limit checks. Chrome and other servers can reach files and network services available inside their execution environment. Restrict whitelist membership, credentials, mounts and network access; MCP annotations and fetched content do not grant permission. The browser server may collect usage statistics unless explicitly disabled in its configuration.

To disable MCP connections and subprocesses, set every server to `enabled: false` or use `{"mcpServers": {}}`, then restart. Codemode remains available for non-MCP tools. Keep session/state volumes; do not run `docker compose down -v`. Existing SQLite data is unchanged, and interrupted side effects must not be automatically retried.

## OpenAI login from Telegram

Configure the ignored root `.env`:

```dotenv
BOT_ADMIN_ID=<your Telegram user ID>
BOT_WHITELIST=<your Telegram user ID>,<other trusted user IDs>
```

Rebuild/restart with `docker compose up -d --build sumire`, then send `/login` in a private chat with the bot. Only the authenticated, explicitly allowlisted admin sender can start login; group and anonymous messages cannot authorize it. Open **Login to OpenAI** in a browser. Complete the ChatGPT sign-in, then paste the full `http://127.0.0.1:1455/auth/callback?...` URL back into the same private chat if the callback does not finish automatically. In Docker or on a remote host, the browser may show a connection error at that address; copy the URL from its address bar anyway. Pi validates the OAuth state and exchanges the code. Do not send API keys or access/refresh tokens to Telegram.

After login, all bot chats share the account immediately, without a restart. Only one login runs at a time. `/cancel` in the login chat cancels that login instead of a model task; it does not log out or revoke already saved credentials. The flow expires after five minutes. Shutdown cancels pending interaction, and a new `/login` can retry. Authentication messages use bounded direct Telegram delivery, never Morsel. Callback input is intercepted before ordinary commands, model context, session persistence, or request telemetry; callback messages are deleted when Telegram permits. Known callback URLs pasted after cancellation, timeout, or restart, including command arguments and quoted replies, are also intercepted. Other chats remain usable during login when a previous credential exists.

If `/login` is unavailable, its reply reports when the admin user ID is missing from the explicit whitelist. If the settings qualify but the login service is absent, the reply directs the admin to check the deployed version and startup logs instead of changing valid settings. Redeploy after environment changes so the running bot loads them.

Pi stores the shared credential at `.telegramagent/sessions/.pi-agent/auth.json` and the stable installation ID in that directory's `settings.json`. Compose persists both in the existing `state` volume. Keep the directory private, writable, and out of Git; Pi needs write access to refresh tokens. No Telegram callback port needs publishing when using the manual URL flow. There is no Telegram logout command or Sumire-owned endpoint/API-key setting. Provision or remove credentials through Pi's supported mechanisms if needed; do not delete unrelated session state.

Telegram bot chats are **not end-to-end encrypted**. The callback contains a short-lived authorization code and is sent through Telegram; best-effort deletion does not guarantee removal from Telegram or client history. Browser authorization links also remain chat data. Prefer local Pi login and securely provision the bot's credential storage if this privacy tradeoff is unacceptable. Account/model availability and usage limits depend on OpenAI's grant and subscription. `/login` authorization is not a filesystem sandbox: existing trusted users have `read`, `write`, and `bash` and can access bot credentials with the process's permissions. Restrict the whitelist accordingly.

The reusable package is `packages/login/`. Its standalone Pi command is `/provider-login` because `/login` is already reserved by Pi's built-in UI. Telegram `/login` uses the same package client through a bot-owned transport adapter, not a model prompt or a separate agent loop.

## Telegram message length and Morsel

Except for the bounded, non-public authentication messages described above, every outgoing text message and edit uses the same delivery policy, including AI answers, commands such as `/t`, and progress updates. Messages over **1000 characters** must be published to Morsel in full; Telegram receives only a short notice and the share URL. Exactly 1000 characters can be sent directly. Length is counted as Unicode code points after control-character cleanup and newline normalization, before HTML escaping; whitespace and Markdown syntax count toward the limit.

Set `MORSEL_API_KEY` to enable publication. If the key is missing, publishing fails, or the returned link cannot fit, Telegram receives only a short failure notice with the sanitized, bounded failure reason. The original long message is never sent inline, split into chunks, or recorded as successfully delivered. The policy applies regardless of the optional rich-tool mode, and legacy thresholds cannot raise the 1000-character cap. Successful Morsel links retain reply-tree checkpoint mapping; `/reset` invalidates pending delivery so stale links do not replace the cancelled status. A full progress snapshot above 1,000 characters is available only through its Morsel link, not inline or in chunks; if publication fails, Telegram shows the failure notice rather than a partial step list.

## Logging

Logs are always written to stderr with Telegram tokens, API keys, authorization headers, cookies, passwords, named secrets, and complete HTTP(S) URLs redacted. Set `LOGFIRE_TOKEN` to also send the same redacted `DEBUG`, `INFO`, `WARN`, and `ERROR` records to Pydantic Logfire under the `sumire` service. Logfire is optional; configuration, span, export, or shutdown failures fall back to stderr without stopping the bot. With Logfire enabled, each addressed request has a `telegram.request` span (chat/message/update IDs, input counts and a process-local HMAC-SHA-256 fingerprint for a URL-only message), with `pi.submit`, `url.load`, `telegram.deliver`, and `morsel.publish` child spans where applicable. `url.load` records the exact requested URL's fingerprint, the successful final hostname and fingerprint, the Pi tool-call ID, source/loader, character count, truncation and outcome. When source-aware loading runs, it also records bounded, allowlisted loader-attempt IDs, statuses (including cancellation versus timeout), elapsed seconds bounded to 0–3,600, error types and codes (such as a Firecrawl API HTTP status or a typed TLS certificate failure); it does not add raw URLs, upstream error messages, prompts, extracted text or Morsel share links as custom span attributes. Pi tool start/end, session/branch selection, model token usage, retries and compaction have metadata-only logs. Match `telegram.input_url_fingerprint` against `url.fingerprint` within a trace to detect a wrong URL; equivalent but differently formatted URLs can have different fingerprints. The HMAC key changes on process restart. Logfire's Node HTTP and undici auto-instrumentations are disabled because they capture raw request URLs, including Telegram bot tokens and sensitive query strings. The bot-owned manual spans above remain enabled; failed manual operations record only a fixed error outcome instead of sending raw upstream exception text into Logfire span events. Other instrumentation or errors introduced later must be reviewed before export; keep Logfire access restricted. Older traces created before this fix may still contain Telegram credentials: restrict access, handle retention/deletion, and revoke and replace any exposed bot token.

Telegram polling retries transient failures such as `ECONNRESET` every five seconds, also honoring Telegram's `retry_after` when rate-limited. Failures use the redacting logger rather than grammY's raw console output: one warning per minute during an outage, followed by a recovery message. Unauthorized-token (`401`) and competing-poller (`409`) errors stop the process immediately; other polling failures stop it after the runner's 15-hour retry window. Fatal errors are also redacted and exit with a nonzero status so Compose can restart the service.

If polling warnings continue, check the container's outbound HTTPS connection to `api.telegram.org`, including any VPN, proxy, or firewall. Retries cannot fix a blocked network. If a token has appeared in old logs, revoke it via @BotFather, replace `BOT_TOKEN` in `.env`, and rebuild/recreate the service with `docker compose up -d --build sumire`.

## Channel image input (`read_image`)

Disabled by default. Add the **channel chat ID** (a negative Telegram ID, typically starting with `-100`) to `BOT_WHITELIST` in the ignored root `.env`, set `BOT_CHANNEL_IMAGE_INPUT_ENABLED=true` and keep `BOT_IMAGE_INPUT_ENABLED=true`, then restart. Obtain the ID through a trusted Telegram update inspection or a channel ID lookup; `/id` reports chat IDs only in existing user/group conversations. The bot must be an administrator of the channel to receive new `channel_post` updates and access its images; it does **not** need permission to publish posts. Grant only the minimum channel permissions Telegram requires. Do not put the bot token in a post or the repository.

The bot subscribes to `message` and `callback_query`, plus `channel_post` only when both flags are enabled. A channel post is accepted **only** when its channel `chat.id` is in `BOT_WHITELIST`, regardless of `from.id`, `sender_chat`, caption, or the normal user-ID allowance for private/group conversations. Accepted new `photo` or image `document` posts are indexed without downloading media, invoking Pi, or sending a channel message. Non-image posts, edited posts, and unauthorized channels are ignored; album items are indexed separately. Channel commands and captions do not run the agent. Ordinary private/group messages and `/cancel`/`/reset` keep their existing behavior.

When an allowlisted user or group asks about channel images, Pi can call `read_image` without arguments to list up to 10 recent indexed channel/message IDs and bounded captions, then call with `channel_chat_id` and `message_id` to download one image into the Pi tool result. Responses go only to the requesting private/group chat through the existing delivery path; **no output is ever posted to the source channel**. All users who can address the bot in an allowlisted group, and all allowlisted users, may use this tool to read indexed images from **any** allowlisted channel. Do not allowlist a public group or a private channel unless this cross-chat access is intended. The tool does not authorize by a sender ID on channel posts.

Only posts received while enabled are indexed; Telegram does not offer a general API for fetching historic channel messages, and pending updates expire after at most 24 hours. Metadata (including truncated captions and Telegram file IDs, **not image bytes**) persists under `.telegramagent/sessions/channel-images/` with file permissions limited to the bot user, at most 100 posts and 256 KB per channel. Old entries are evicted by message order when either bound is reached, so fewer than 100 may remain. A missing, expired, or oversized file returns a tool error rather than an invented image. `BOT_IMAGE_MAX_BYTES` bounds both declared and streamed image bytes; downloads time out after 60 seconds and tool cancellation aborts the fetch. The image and caption are untrusted input; Pi's coding tools still run with the bot process's filesystem and environment privileges. Tool use incurs model and download costs only on user turns; it does not run for every post. Do not treat the channel as a tool sandbox.

To disable quickly, set `BOT_CHANNEL_IMAGE_INPUT_ENABLED=false` and restart (or remove channel IDs from `BOT_WHITELIST` and restart). Existing indexed metadata is retained in the state volume but cannot be read through `read_image` while disabled or after removing that channel ID. Do not delete the state volume to roll back; restore the previous image/version if needed. Validate with `npm test --workspace @narumitw/sumire` and, after deployment, post a **new** image to an allowlisted test channel, ask the bot in a permitted private/group chat to read it, and verify a non-image post and an unauthorized channel cause no tool use or download. This PR relies on automated tests instead of a live test channel; real Telegram channel delivery, permissions, and retention remain unverified deployment risks.

## Document input

Public Office, OpenDocument, RTF, EPUB, and CSV URLs can also be loaded through `load_public_url` using the URL content package's `anydoc` loader. URL documents and Telegram attachments share the isolated child-process conversion runner; their admission limits remain separate. Native conversion is local and hosted OCR is disabled.

When `BOT_DOCUMENT_INPUT_ENABLED=true`, current and replied Word, PowerPoint, Excel, OpenDocument, RTF, EPUB, CSV, and text-based PDF attachments are downloaded with byte and time bounds, then converted in a killable child process. Raw bytes remain in memory and are not persisted. Converted Markdown is truncated to one aggregate prompt budget and delimited as untrusted reference material. Scanned PDFs that require OCR, encrypted or malformed documents, timeouts, and resource-limit failures return direct Traditional Chinese errors without invoking Pi.

`BOT_DOCUMENT_MAX_CONCURRENT_CONVERSIONS` limits the entire download-and-convert operation across all chats and both current/replied attachments. A shared slot is acquired before Telegram `getFile` or download starts and retained until conversion settles, including child-process close after errors or timeouts. Waiting jobs retain only attachment metadata and a lazy loader, not downloaded bytes. With the defaults, at most two 20,000,000-byte document inputs are admitted (40,000,000 input bytes); download/IPC copies, native conversion memory, images, and runtime overhead are additional, so this is not a total process-memory cap. Download and conversion failures release their slot for queued work.

`/cancel` invalidates pending input in that chat before invoking Pi's native cancellation. Queued document loaders are skipped, late results/errors do not reach Pi or produce stale replies, and new messages can proceed. Downloads or native conversions already in flight retain their slot and drain to completion or their existing timeout; cancellation does not claim to terminate these operations immediately.

Replying to a document while mentioning the bot uses the bounded media-input pipeline, including feature flags, direct failures, cancellation, and reply-tree restoration. In private chats, send the question directly; in groups, mention the bot or reply to its message.

The production image currently qualifies the AnyDoc native adapter on Linux x86_64 glibc. Other architectures are not release-qualified even if upstream optional packages exist. Disable `BOT_DOCUMENT_INPUT_ENABLED` if the native adapter is unavailable.

## Local audio transcription

The production image installs `yt-dlp`, FFmpeg, and the Python `openai-whisper` CLI with a CPU PyTorch runtime. The YouTube loader tries captions first, then downloads audio and transcribes it with the local `tiny` model; Instagram Reels use the same local audio transcription path. URL media remains subject to the public URL validation and the URL content timeout. It does not call OpenAI's hosted audio API.

Voice notes and audio attachments sent to Sumire (or replied to with an addressed message) are downloaded only when their conversion slot is free. The streamed download is bounded to `BOT_AUDIO_MAX_BYTES` (default 20 MB); Telegram's reported duration is checked against `BOT_AUDIO_MAX_DURATION_SECONDS` (default 600 s). This metadata check does not verify the actual audio duration: the transcription also has a 180-second deadline and a 12,000-character transcript limit. Only one Telegram audio input transcribes at once; each request uses a private temporary file removed after success or failure. Transcripts are passed to Pi as explicitly untrusted reference text alongside the caption or question. Use `BOT_AUDIO_INPUT_ENABLED=false` to disable this input without disabling video-link loading. Unsupported/corrupt audio, download errors, and missing local tools produce a direct error rather than an invented transcript. Cancellation skips queued work and suppresses late results; an already running transcription finishes or times out before freeing its slot.

The first use of the local `tiny` model downloads model weights. Compose keeps the cache in the `whisper-cache` volume, so later restarts do not repeat that download; the container needs network access for the first transcription. Local development requires `yt-dlp`, `whisper` from `openai-whisper`, and FFmpeg on `PATH`. This CPU-only stack increases image size and may take time to build or transcribe.

## URL content loading

The [`@narumitw/sumire-url-tool`](../../packages/url-tool/README.md) Pi extension registers `load_public_url`. It validates the original target as public HTTP(S), then tries the bounded built-in text/HTML loader. It falls back to the local `@narumitw/sumire-url-content` workspace package when built-in loading fails, returns a blocker page, or encounters source-specific content. Threads post URLs and `/share/<id>` links go directly to bounded metadata extraction so the JavaScript application shell or a dead-link page cannot be mistaken for a post. Share links require matching canonical and Open Graph post URLs; results may contain only the Open Graph excerpt, not the entire post. The package handles richer sources such as transcripts, social posts, PDFs, GitHub files, and browser-rendered pages.

The `load_public_url` tool and its bundled `load-public-url` skill are available by default. The separate `load-url-content` CLI skill from the URL-content package is also always available; it uses the native `bash` tool. The required `BOT_WHITELIST` restricts access to both coding tools and URL-loading capabilities.

The agent can optionally request one of the bot's approved exact loaders: `built-in`, `httpx`, `curl-cffi`, `playwright`, or `firecrawl`. Omission keeps automatic selection; an explicit selection runs only that loader and reports its failure without switching to another path. `firecrawl` requires `FIRECRAWL_API_KEY`; an HTTP error from that loader is attributed to the Firecrawl API, not the target site. A Threads share link cannot succeed with an unverified generic override. This fixed host allowlist prevents arbitrary registered loaders from being selected through the tool call.

`BOT_URL_TIMEOUT_SECONDS` and `BOT_URL_MAX_EXTRACTED_CHARS` control the built-in/DNS phase limit and output limit; `BOT_URL_CONTENT_TIMEOUT_SECONDS` controls the total tool deadline, including validation and the built-in phase, and the shared `/f` source deadline. Automatic generic loading tries curl, fast Playwright, HTTP, then network-idle Playwright; each gets the smaller of its cap (15 seconds for fast Playwright, 20 seconds for other local methods) and a fair share of remaining time. Local timeouts continue fallback; total expiry, `/cancel`, and `/reset` stop it. One-shot source cleanup has a separate five-second maximum wait, and never replaces the original load failure.

Both the tool and `/f` enable a final generic Firecrawl fallback (30-second cap) by default after local loaders fail. Missing `FIRECRAWL_API_KEY` or less than one second remaining skip it. Configuring the key allows this fallback to send the URL, including its query, to Firecrawl and may incur charges; provide it only if the operator accepts that external transfer and cost. Explicit `firecrawl` and existing source-specific plans remain unchanged. Reported final targets are checked, but Firecrawl's remote intermediate redirects cannot be inspected locally. `BOT_URL_ALLOWED_SCHEMES` can restrict loading to HTTP, HTTPS, or both. Every path retains its deadlines, cancellation, and bounded output; source-aware loaders also retain their concurrency admission. Unsafe local, private, link-local, and metadata targets are rejected before the selected loader is invoked.

Telegram sends URL-only messages, summary requests, and short follow-ups through the normal Pi conversation path. The agent decides when to call `load_public_url`; the Telegram router does not prefetch URLs or retain pending URL state. For URL-only messages, the system prompt instructs the agent to read the URL in the current message first and not substitute an older or unrelated page. Tool results and follow-up context use Pi Durable's conversation lifecycle.

## Docker

Build and run from the repository root so the Dockerfile can copy `apps/bot/` and `instructions/`:

```bash
docker build -t sumire:local .
docker compose up -d --build
docker compose logs -f sumire
docker compose down
```

The image includes Git, OpenSSH client tools (`ssh`, `ssh-keygen`), and CA certificates for HTTPS cloning. The build checks that Git and SSH tools are available to the non-root bot user. No SSH keys or GitHub credentials are bundled: use a dedicated key with only the required repository permissions, register only its `.pub` public key with GitHub, and never share its private key. All allowlisted users with coding-tool access can read or use credentials available to the bot, so keep the allowlist restricted to trusted users.

The image builds the local URL tool and URL content workspace packages, includes the AnyDoc Linux native adapter, and installs Playwright Chromium with its runtime dependencies. Docker Compose mounts `workdir:/workdir`, not `/app`, so rebuilt images update the running code without masking it. Before migrating from `workdir:/app`, stop the bot and back up the independent `state` volume; legacy AgentSession data from `/app` stays archived and is not imported into Pi Durable. Changing `BOT_WORKDIR` changes the tool directory for subsequent durable calls, so cancel pending work before moving it. Do not use `docker compose down -v`: it removes named volumes, including bot state. If the old `workdir` volume was deleted, restore needed files or SSH keys from a separate backup or generate them again. The bot user's home is `/workdir`, so `~/.ssh` is `/workdir/.ssh` and persists in the new volume.

The production image bundles checksum-verified libcurl-impersonate v2.2.2 for Linux amd64 and arm64, matching `impers` 0.1.2. Archive downloads accept HTTPS redirects only, use 15-second connection and 10-minute attempt timeouts, resume partial archives across up to three retries, and fail on checksum mismatches or unsupported architectures. `LIBCURL_PATH` points to `/opt/curl-impersonate/libcurl-impersonate.so`; runtime library downloads remain disabled with `IMPER_DOWNLOAD_LIBCURL=0`. An offline build check runs as the bot user and verifies every built-in Chrome fingerprint. When updating `impers`, review its pinned libcurl release and update both archive URLs and SHA-256 digests together. This does not enable Firecrawl fallback or guarantee that every website accepts automated requests.

## Feature controls

The root [`.env.example`](../../.env.example) lists document, reply-tree, and image flags plus codemode and other tool limits. Document input, reply-tree routing, and image input can be disabled independently without disabling ordinary Pi chat or `load_public_url`. Reply indexes use bounded durable retention per chat.
