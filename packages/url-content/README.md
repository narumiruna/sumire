# @narumitw/sumire-url-content

A TypeScript and Node.js package that extracts text or Markdown from URLs and automatically chooses a source-safe loader.

## Features

- Source-aware plans for YouTube, Twitter/X, Truth Social, Reddit, Instagram Reels, PTT, GitHub, Google Docs, pi.dev sessions, BBC, CNN, LTN, PDFs, OpenAI pages, and generic web pages
- Local AnyDoc conversion of public Office, OpenDocument, RTF, EPUB, and CSV document URLs in killable child processes
- Ordered fallback attempts with structured status, timing, and error details
- Browser TLS/HTTP fingerprinting through [`impers`](https://github.com/lexiforest/impers)
- Reusable fetch, `impers`, and Playwright resources with concurrency limits and total deadlines
- ESM library API, TypeScript declarations, and a `sumire-url-content` CLI

## Installation

```bash
npm install @narumitw/sumire-url-content
```

## Workspace usage

From this repository root:

```bash
npm install
npm run build --workspace @narumitw/sumire-url-content
npm test --workspace @narumitw/sumire-url-content
npm exec --workspace @narumitw/sumire-url-content -- sumire-url-content --list
```

## Library API

```ts
import { explainPlan, loadUrl, loadUrlDetailed } from "@narumitw/sumire-url-content";

const plan = explainPlan("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
console.log(plan.execution_plan);

const text = await loadUrl("https://example.com", { deadlineSeconds: 30 });
console.log(text);

const result = await loadUrlDetailed("https://github.com/user/repo/blob/main/README.md");
console.log(result.loaderId, result.contentType, result.attempts);
```

The TypeScript API is async-only because JavaScript has no safe synchronous equivalent.

## Reusable client

A client must be started before use and closed when finished. It lazily owns one `impers` session and one Playwright browser.

```ts
import { UrlContentClient } from "@narumitw/sumire-url-content";

await using client = new UrlContentClient({
  deadlineSeconds: 30,
  requestLimit: 8,
  browserLimit: 2,
  workerLimit: 2,
}).start();

const results = await Promise.all([
  client.loadUrl("https://example.com/one"),
  client.loadUrl("https://example.com/two"),
]);
```

A deadline includes time spent waiting for a concurrency slot. Cancellation is propagated through `AbortSignal` where the underlying library supports it.

## CLI

```bash
sumire-url-content https://example.com
sumire-url-content --loader curl-cffi,playwright,httpx https://example.com
sumire-url-content --list
```

Automatic planning is preferred. Explicit loaders are intended for debugging.

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

### Google Docs

The `google-docs` loader converts public document links (`/document/d/<id>`, `/edit`, `/view`, `/preview`, or `/export`, including `/document/u/<account>/d/<id>` variants) to an HTTPS `/export?format=txt` request. It preserves `tab` and `resourcekey` query parameters but drops editor-only parameters and fragments. No Google login, API key, browser, or OAuth token is needed.

Documents must permit unauthenticated viewing and text export. HTTP failures, HTML login/editor pages, non-text responses, and empty exports are rejected rather than passed to generic HTML loaders. Requests and redirects use public-address validation; exports have a 20-second timeout and a 10 MiB response limit. Text is preserved without HTML conversion. Sheets, Slides, and published `/document/d/e/.../pub` links are not handled by this loader.

### Firecrawl

Set `FIRECRAWL_API_KEY` for OpenAI web pages or explicit `firecrawl` loading:

```bash
export FIRECRAWL_API_KEY=...
```

The loader calls Firecrawl's v1 scrape endpoint and requests Markdown.

### AnyDoc

The `anydoc` worker loader uses [`@firecrawl/anydoc`](https://github.com/firecrawl/anydoc) locally to convert public document URLs to Markdown. Automatic matching uses the decoded URL filename, ignoring query parameters and fragments:

- Word: `.doc`, `.docx`, `.docm`
- PowerPoint: `.ppt`, `.pps`, `.pot`, `.pptx`, `.pptm`, `.ppsx`, `.ppsm`
- Excel: `.xls`, `.xlsx`, `.xlsm`, `.xlsb`
- OpenDocument: `.odt`, `.ods`, `.odp`
- Other: `.rtf`, `.epub`, `.csv`

Existing source-specific plans, including Google Docs, GitHub, and PDF, retain precedence. PDF URLs can also be converted explicitly with `sumire-url-content --loader anydoc https://example.com/report.pdf`. Extensionless download endpoints and local Office-file paths are not matched.

Keep npm optional dependencies enabled so the AnyDoc native binding for your platform is installed. Conversion does not require `FIRECRAWL_API_KEY` and always uses `ocr: "reject"`: scanned PDFs requiring OCR fail with `needsOcr`, and documents are never sent to hosted OCR. Format detection uses the bytes first, then the filename for formats such as CSV.

Downloads and redirects use public-address validation. The loader rejects HTML/login pages, HTTP errors, and empty documents; it caps downloads at 20,000,000 bytes, download plus conversion at 30 seconds, and Markdown at 1,000,000 characters plus an explicit truncation marker. Within a reusable `UrlContentClient`, worker admission covers the download and conversion together. Cancellation or timeout kills the isolated child; conversion capacity is retained until the child closes. The shared child runner is exported from `@narumitw/sumire-url-content/anydoc` and is also used for Telegram attachments.

### PDF

Automatic PDF parsing still uses `pdf-parse`. Remote targets must return `application/pdf`; local `.pdf` paths are also supported. Explicit `anydoc` loading supports remote PDF URLs only.

### yt-dlp and Whisper

YouTube captions use `youtube-transcript`. The `youtube-ytdlp`, `ytdlp`, and `reel` loaders need external commands:

- `yt-dlp`
- OpenAI Whisper's `whisper` CLI
- FFmpeg

The transcription loader writes only to an isolated temporary directory and removes it after each attempt.

## Extraction policy

Strict source plans do not accept unrelated generic HTML:

- YouTube video URLs require transcript output.
- Twitter status, Reddit, Truth Social, PTT, Reel, PDF, pi.dev session, GitHub, and Google Docs plans require their matching source loader.
- BBC, CNN, and LTN use the same article extractor after HTTP, `impers`, or browser retrieval.
- Generic pages try `curl-cffi` (`impers`), Playwright network-idle, faster Playwright, then standard fetch.
- AnyDoc document plans require native document conversion and do not fall back to generic HTML.
- Empty output and recognized challenge headings are rejected so the chain can continue.

## Implementation notes

- Names use TypeScript camelCase (`loadUrl`, `explainPlan`, `loaderId`). `toObject()` helpers expose snake_case diagnostic objects.
- HTML-to-Markdown conversion uses Turndown, so whitespace and Markdown punctuation may differ while preserving extracted content.
- Browser-like HTTP requests use `impers`.
- Audio transcription invokes the Python-installed Whisper CLI instead of embedding a Whisper runtime in Node.js.
- YouTube language preference is attempted in order through `youtube-transcript`.

## Development

```bash
npm run format:check --workspace @narumitw/sumire-url-content
npm run lint --workspace @narumitw/sumire-url-content
npm run typecheck --workspace @narumitw/sumire-url-content
npm test --workspace @narumitw/sumire-url-content
npm run build --workspace @narumitw/sumire-url-content
```
