# @narumitw/sumire-url-content

## 0.20.0

### Minor Changes

- bde8fbb: Add an AnyDoc worker loader for public Office, OpenDocument, RTF, EPUB, and CSV URLs, with explicit AnyDoc support for remote PDFs. Preserve existing source-specific plans and route known document URLs past the built-in HTML loader. Share isolated, abortable native conversion with Telegram attachments, enforce download/output limits, and keep hosted OCR disabled.
- c0abc91: Add a dedicated Google Docs loader that exports public documents as bounded plain text while preserving tab and resource-key parameters. Route Google Docs links directly to it instead of fetching editor HTML, reject login pages and unsafe redirects, and preserve source error details.

## 0.19.7

### Patch Changes

- 3781f36: Publish the URL content loader as a public npm package.
