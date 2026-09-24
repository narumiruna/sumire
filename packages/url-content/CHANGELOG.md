# @narumitw/sumire-url-content

## 0.22.1

### Patch Changes

- f71efc8: Bundle the URL-content CLI skill as a local Pi package resource, and load it in the bot only when coding tools are enabled.
- fef1294: Remove non-visible scripts, styles, noscript blocks, and templates before generic HTML-to-Markdown conversion so bounded public URL output contains readable page content instead of page assets.
- b64107b: Enable local yt-dlp and Whisper transcription for YouTube and Reels in the production image, and transcribe bounded Telegram voice and audio inputs before submitting untrusted transcript context to Pi. Canonicalize video URLs passed to yt-dlp and ignore user CLI configuration.
- aa6345b: Verify Threads share links against post metadata before returning content, preserve safe loader diagnostics, and attribute Firecrawl API errors correctly.

## 0.22.0

### Minor Changes

- be660f2: Add allowlisted exact loader selection to `load_public_url`, backed by reusable explicit URL content chains that retain public-target validation, deadlines, cancellation, admission limits, and bounded output.

## 0.21.0

### Minor Changes

- d416c5f: Add bounded public Threads post extraction that verifies canonical metadata and returns the decoded author and post body instead of the Threads application shell.

### Patch Changes

- ced9e34: Document and test Kabigon `0.19.6` loader parity, and preserve process-group escalation until descendants that survive `SIGTERM` receive `SIGKILL`.

## 0.20.1

### Patch Changes

- 6765dcf: Mark all shared workspace packages as private to prevent accidental npm publication.

## 0.20.0

### Minor Changes

- bde8fbb: Add an AnyDoc worker loader for public Office, OpenDocument, RTF, EPUB, and CSV URLs, with explicit AnyDoc support for remote PDFs. Preserve existing source-specific plans and route known document URLs past the built-in HTML loader. Share isolated, abortable native conversion with Telegram attachments, enforce download/output limits, and keep hosted OCR disabled.
- c0abc91: Add a dedicated Google Docs loader that exports public documents as bounded plain text while preserving tab and resource-key parameters. Route Google Docs links directly to it instead of fetching editor HTML, reject login pages and unsafe redirects, and preserve source error details.

## 0.19.7

### Patch Changes

- 3781f36: Publish the URL content loader as a public npm package.
