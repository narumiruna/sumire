# @narumitw/sumire-url-reader

A TypeScript and Node.js package that extracts text or Markdown from URLs and automatically chooses a source-safe loader.

## Features

- Source-aware plans for YouTube, Twitter/X, Threads, Truth Social, Reddit, Instagram Reels, PTT, GitHub, Google Docs, pi.dev sessions, BBC, CNN, LTN, PDFs, OpenAI pages, and generic web pages
- Local AnyDoc conversion of public Office, OpenDocument, RTF, EPUB, and CSV document URLs in killable child processes
- Ordered fallback attempts with structured status, timing, and error details
- Browser TLS/HTTP fingerprinting through [`impers`](https://github.com/lexiforest/impers)
- Reusable fetch, `impers`, and Playwright resources with concurrency limits and total deadlines
- ESM library API, TypeScript declarations, and a `sumire-url-reader` CLI

## Installation

```bash
npm install @narumitw/sumire-url-reader
```

## Workspace usage

From this repository root:

```bash
npm install
npm run build --workspace @narumitw/sumire-url-reader
npm test --workspace @narumitw/sumire-url-reader
npm exec --workspace @narumitw/sumire-url-reader -- sumire-url-reader --list
```

## Library API

```ts
import { explainPlan, loadUrl, loadUrlDetailed } from "@narumitw/sumire-url-reader";

const plan = explainPlan("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
console.log(plan.execution_plan);

const text = await loadUrl("https://example.com", { deadlineSeconds: 30 });
console.log(text);

const result = await loadUrlDetailed("https://github.com/user/repo/blob/main/README.md");
console.log(result.loaderId, result.contentType, result.attempts);

const explicit = await loadUrlDetailed("https://example.com/article", {
  loaderNames: ["httpx"],
});
console.log(explicit.loaderId); // httpx
```

The TypeScript API is async-only because JavaScript has no safe synchronous equivalent. `loaderNames` supplies an exact ordered chain: only those loaders are attempted, in order, and failure does not return to automatic planning. Unknown and empty lists are rejected. Prefer automatic planning unless a trusted caller needs a controlled override.

The one-shot API accepts `allowedSchemes: new Set(["https"])` to restrict network targets to HTTPS. The same option is available on the `UrlContentClient` constructor. The default permits public HTTP and HTTPS; the option can restrict that set, not permit other protocols. The client copies the set and applies it to initial targets, local fetch redirects, browser requests, curl redirect validation and proxy forwarding, and reported Firecrawl final targets. Firecrawl intermediate redirects and navigation inside third-party transcript/media tools are not independently inspected by this policy.

## Reusable client

A client must be started before use and closed when finished. It lazily owns one `impers` session and one Playwright browser.

```ts
import { UrlContentClient } from "@narumitw/sumire-url-reader";

await using client = new UrlContentClient({
  deadlineSeconds: 30,
  requestLimit: 8,
  browserLimit: 2,
  workerLimit: 2,
}).start();

const results = await Promise.all([
  client.loadUrl("https://example.com/one"),
  client.loadUrl("https://example.com/two", { loaderNames: ["httpx"] }),
]);
```

A deadline starts before target validation and includes loader construction and waiting for a concurrency slot. Automatic generic attempts use the smaller of their cap and remaining time divided by remaining eligible alternatives: 15 seconds for fast Playwright, 20 seconds for other local methods, and 30 seconds for Firecrawl. Missing requirements are not included in that division. Local attempt timeouts continue the chain; a shared deadline or caller cancellation stops it. Without a shared deadline, the same per-attempt caps still apply. Explicit chains and source-required plans retain their existing limits instead of using generic budget allocation.

Cancellation is propagated through `AbortSignal`; waiting is bounded even if an operation ignores cancellation. Browser navigation is interrupted and its context is closed. The one-shot API allows up to five additional seconds for client cleanup; cleanup continues if that wait expires, and never replaces an original load failure. Reusable clients remain responsible for awaiting `close()`. `getInterruptedAttempts(error, url)` exposes safe attempt records for that URL while preserving the caller's original cancellation reason and identity, including concurrent URLs sharing a signal. Omitting `url` returns the most recently stored records; interruption statuses distinguish `cancelled` from `timeout`.

## Failure diagnostics

`LoaderError.attempts` retains ordered loader outcomes. Each failed attempt can include an additive `diagnostic: FailureDiagnostic` field. `getInterruptedAttempts(error, url)` retains the same fields for cancellation and shared deadlines without changing the original abort reason. Existing `errorCode` values, including `target_http_403`, `firecrawl_api_http_403`, `tls_certificate`, and `transport_failure`, remain compatible.

`FailureDiagnostic` contains only these facts:

- `code: FailureCode`: a stable category from the table below.
- `phase?`: `captions`, `metadata`, `download`, `transcription`, `loading`, or `validation`.
- `limit?` and `observed?`: finite, nonnegative numeric facts. Duration uses seconds; media size uses bytes.
- `dependency?`: `yt-dlp`, `whisper`, or `ffmpeg`, when established by structured evidence.
- `httpStatus?`: the HTTP status, when known. The code distinguishes a service API status from a target status.

| Code | Evidence |
| --- | --- |
| `captions_unavailable` | The caption library did not obtain usable caption tracks; this does not establish an author setting. |
| `caption_language_unavailable` | The caption library reported that the requested language was unavailable. |
| `captions_empty` | Caption extraction returned no non-whitespace text. |
| `caption_extraction_failed` | Caption extraction failed without a more specific established cause. |
| `media_duration_limit` | Valid numeric metadata exceeded the configured duration limit. |
| `media_size_limit` | The downloaded audio file exceeded the configured byte limit. |
| `dependency_missing` | A required executable was missing, as reported by a structured system error. |
| `metadata_failed`, `download_failed`, `transcription_failed` | The corresponding phase failed; no source restriction or limit rejection is implied. |
| `download_timeout`, `transcription_timeout` | The corresponding local budget expired. The download budget includes metadata. |
| `loader_timeout` | A local loader budget expired. `limit` uses seconds; this is not a shared deadline. |
| `target_http_error`, `service_http_error` | A typed HTTP failure from the target website or service API, respectively. |
| `transport_failure`, `tls_certificate` | A structured transport or certificate failure. |
| `deadline_exceeded`, `cancelled` | A shared deadline or caller cancellation, respectively. Neither establishes missing captions or a Whisper timeout. |
| `empty_content`, `configuration_missing`, `unknown` | Empty output, missing configuration, or no established specific cause. |

`FailureDiagnosticError extends LoaderContentError` accepts `(loaderName, url, diagnostic)` and exposes `.diagnostic`. `getFailureDiagnostic(error)` classifies typed facts; use aggregate attempts rather than classifying a `LoaderError` as one cause. `LoaderTimeoutError` and `MissingDependencyError` accept an optional final diagnostic argument and retain their existing class identities.

`attemptRecordToObject` adds `diagnostic` (or `null`) to its existing serialized fields. The nested diagnostic uses the TypeScript field names, including `httpStatus`. Do not use raw exception messages, `LoaderError.details`, or attempt `message` fields as a user-facing or logging contract. Presentation boundaries must allowlist and validate diagnostic fields. Classification does not match upstream messages or command stderr.

## CLI

```bash
sumire-url-reader https://example.com
sumire-url-reader --loader curl-cffi,playwright,httpx https://example.com
sumire-url-reader --list
```

Automatic planning is preferred. Explicit loaders are exact overrides for debugging or allowlisted host integrations; they retain target validation, deadlines, cancellation, resource admission, and requirement checks.

## Pi integration

This package provides the library and `sumire-url-reader` CLI; it does not register Pi tools or bundle Pi skills. Use [`@narumitw/sumire-pi-url-reader`](../pi-url-reader/README.md) for the `read_url_content` tool and both URL-reading skills.

## Name migration

This package was previously `@narumitw/sumire-url-content` in `packages/url-content`. Update imports and workspace paths to `@narumitw/sumire-url-reader` and `packages/url-reader`; replace the `sumire-url-content` CLI command with `sumire-url-reader`. The library API names, including `UrlContentClient`, are unchanged. Pi skill consumers must load `pi-url-reader` instead of this package.

## Runtime requirements

### `impers`

The `curl-cffi` loader uses `impers` with `impersonate: "chrome"`. On first use, `impers` may download its pinned `libcurl-impersonate` build. Set `LIBCURL_PATH` to use an existing library. Standard libcurl works without browser fingerprint impersonation.

### Playwright

Install Chromium for the browser and social loaders:

```bash
npx playwright install chromium
```

### Twitter/X

The Twitter loader first requests the exact status from `api.fxtwitter.com` and verifies the returned status ID. It falls back to Playwright when that API is unavailable. This avoids returning X login or error pages when X blocks browser automation.

### Threads

The `threads` loader recognizes public `threads.com` and `threads.net` post permalinks and `/share/<id>` links. For a share link it requests the mobile page, requires matching Open Graph and canonical post URLs, and applies the existing post metadata extractor. An error page, missing/mismatched post metadata, or a redirect away from the requested Threads share/post fails rather than falling back to generic web scraping. The result contains the author, canonical post URL, and decoded public Open Graph description, which may be only an excerpt of a longer post. Requests and every redirect retain public-target validation, a 20-second timeout, and a 2 MiB response limit.

### Google Docs

The `google-docs` loader converts public document links (`/document/d/<id>`, `/edit`, `/view`, `/preview`, or `/export`, including `/document/u/<account>/d/<id>` variants) to an HTTPS `/export?format=txt` request. It preserves `tab` and `resourcekey` query parameters but drops editor-only parameters and fragments. No Google login, API key, browser, or OAuth token is needed.

Documents must permit unauthenticated viewing and text export. HTTP failures, HTML login/editor pages, non-text responses, and empty exports are rejected rather than passed to generic HTML loaders. Requests and redirects use public-address validation; exports have a 20-second timeout and a 10 MiB response limit. Text is preserved without HTML conversion. Sheets, Slides, and published `/document/d/e/.../pub` links are not handled by this loader.

### Firecrawl

Set `FIRECRAWL_API_KEY` for OpenAI web pages or explicit `firecrawl` loading:

```bash
export FIRECRAWL_API_KEY=...
```

The loader calls Firecrawl's v1 scrape endpoint and requests Markdown. An HTTP error is reported as an error from the Firecrawl API, not from the target website. Responses are streamed with a 10 MiB cap, empty/challenge results are rejected, and reported final URLs are validated as public targets under the client's scheme policy. Firecrawl performs remote navigation; intermediate redirects inside that service cannot be independently inspected by this package.

Hosts can pass `firecrawlApiKey?: string | null` to `loadUrl`, `loadUrlDetailed`, the `UrlContentClient` constructor, and each client load. A per-load value overrides the constructor value. Omitted or `undefined` uses the standalone `FIRECRAWL_API_KEY` environment setting; explicit `null` disables environment fallback, including requirement checks and loader eligibility. An empty string also means unavailable. Each load captures its credential before asynchronous work, so concurrent loads can use different keys without changing the environment. `explainPlan`, `explainLoadChain`, `resolveLoadChain`, and `resolveExplicitLoadChain` accept the same option. `createLoader` and `getLoaderFactory` accept it in their third argument; direct `FirecrawlLoader` construction uses `apiKey?: string | null`.

Firecrawl removes exact echoes of the operation's credential from returned Markdown and uses fixed public errors without upstream bodies or exception causes. The operation retains its redactor during key replacement or deletion. Exact-value redaction does not remove transformed or encoded values and is not an isolation boundary.

For ordinary HTML pages, opt in with `loadUrlDetailed(url, { firecrawlFallback: true })` or `client.loadUrlDetailed(url, { firecrawlFallback: true })`. This adds Firecrawl after all local generic alternatives. The default is `false`, even when an API key exists: opting in sends the target URL (including its query) to an external service and may incur charges. Missing keys skip this alternative; less than one second of remaining time also skips it. Explicit Firecrawl selection and the existing OpenAI web pipeline are unchanged. Source-required document and social pipelines never gain generic fallback.

### AnyDoc

The `anydoc` worker loader uses [`@firecrawl/anydoc`](https://github.com/firecrawl/anydoc) locally to convert public document URLs to Markdown. Automatic matching uses the decoded URL filename, ignoring query parameters and fragments:

- Word: `.doc`, `.docx`, `.docm`
- PowerPoint: `.ppt`, `.pps`, `.pot`, `.pptx`, `.pptm`, `.ppsx`, `.ppsm`
- Excel: `.xls`, `.xlsx`, `.xlsm`, `.xlsb`
- OpenDocument: `.odt`, `.ods`, `.odp`
- Other: `.rtf`, `.epub`, `.csv`

Existing source-specific plans, including Google Docs, GitHub, and PDF, retain precedence. PDF URLs can also be converted explicitly with `sumire-url-reader --loader anydoc https://example.com/report.pdf`. Extensionless download endpoints and local Office-file paths are not matched.

Keep npm optional dependencies enabled so the AnyDoc native binding for your platform is installed. Conversion does not require `FIRECRAWL_API_KEY` and always uses `ocr: "reject"`: scanned PDFs requiring OCR fail with `needsOcr`, and documents are never sent to hosted OCR. Format detection uses the bytes first, then the filename for formats such as CSV.

Downloads and redirects use public-address validation. The loader rejects HTML/login pages, HTTP errors, and empty documents; it caps downloads at 20,000,000 bytes, download plus conversion at 30 seconds, and Markdown at 1,000,000 characters plus an explicit truncation marker. Within a reusable `UrlContentClient`, worker admission covers the download and conversion together. Cancellation or timeout kills the isolated child; conversion capacity is retained until the child closes. The shared child runner is exported from `@narumitw/sumire-url-reader/anydoc` and is also used for Telegram attachments.

### PDF

Automatic PDF parsing still uses `pdf-parse`. Remote targets must return `application/pdf`; local `.pdf` paths are also supported. Explicit `anydoc` loading supports remote PDF URLs only.

### yt-dlp and Whisper

YouTube captions use `youtube-transcript`. The `youtube-ytdlp`, `ytdlp`, and `reel` loaders need external commands:

- `yt-dlp`
- OpenAI Whisper's `whisper` CLI
- FFmpeg

The transcription loader writes only to an isolated temporary directory and removes it after each attempt. YouTube and Reel audio downloads strip arbitrary URL query parameters and use canonical video URLs; the CLI is launched without user-level yt-dlp configuration.

Before download, yt-dlp emits only a JSON duration field. Metadata and download share the existing 120-second download budget and cancellation signal. Valid finite duration metadata above 3,600 seconds rejects the media before download. Missing, negative, nonnumeric, or unsafe duration values do not establish a duration rejection; download filters remain enabled. Malformed metadata or a failed metadata command reports `metadata_failed`. An absent filtered audio file reports `download_failed`, not a duration or size rejection. Metadata does not provide a reliable final MP3 byte size; the loader retains the 100 MiB download filter and checks the actual audio file before Whisper starts.

Every external command has a combined 1 MiB stdout/stderr cap; exceeding it terminates the process group. Whisper retains its separate 300-second budget. Missing executables are identified only from `ENOENT` at command invocation; stderr does not establish a missing FFmpeg dependency or a source restriction. The existing limitation on independent inspection of third-party media redirects also applies to metadata.

## Extraction policy

Strict source plans do not accept unrelated generic HTML:

- YouTube video URLs require transcript output.
- Twitter status, Threads post/share, Reddit, Truth Social, PTT, Reel, PDF, pi.dev session, GitHub, and Google Docs plans require their matching source loader.
- BBC, CNN, and LTN use the same article extractor after HTTP, `impers`, or browser retrieval.
- Generic pages try `curl-cffi` (`impers`), fast Playwright (`domcontentloaded`), standard fetch, then Playwright network-idle; opted-in Firecrawl is last. Successful extraction stops further attempts.
- AnyDoc document plans require native document conversion and do not fall back to generic HTML.
- Generic HTML and XHTML conversion removes `script`, `style`, and `template` nodes before Markdown extraction, but keeps readable no-JavaScript content inside `noscript`. Non-HTML textual responses retain literal tags instead of being parsed as HTML; escaped markup in visible HTML code examples is preserved. Empty output and recognized challenge headings are rejected so the chain can continue.

## Kabigon compatibility

All 20 loader IDs from Kabigon `0.19.6` remain registered. This is name and contract compatibility, not byte-for-byte behavioral identity. Sumire keeps stricter source verification, public-target and redirect checks, bounded responses and media, cancellation cleanup, and Node.js-specific transport/transcription implementations. The versioned [Kabigon loader parity matrix](../../docs/kabigon-loader-parity.md) records applicability, pipeline placement, resource admission, limits, outputs, failures, and intentional differences for every baseline loader. Sumire-only loaders are documented separately as `anydoc`, `threads`, and `google-docs`.

## Implementation notes

- Names use TypeScript camelCase (`loadUrl`, `explainPlan`, `loaderId`). `toObject()` helpers expose snake_case diagnostic objects.
- HTML-to-Markdown conversion uses Turndown, so whitespace and Markdown punctuation may differ while preserving extracted content.
- Browser-like HTTP requests use `impers`.
- Audio transcription invokes the Python-installed Whisper CLI instead of embedding a Whisper runtime in Node.js.
- YouTube language preference is attempted in order through `youtube-transcript`.

## Development

```bash
npm run format:check --workspace @narumitw/sumire-url-reader
npm run lint --workspace @narumitw/sumire-url-reader
npm run typecheck --workspace @narumitw/sumire-url-reader
npm test --workspace @narumitw/sumire-url-reader
npm run build --workspace @narumitw/sumire-url-reader
```
