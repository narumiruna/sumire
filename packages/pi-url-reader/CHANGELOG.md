# @narumitw/sumire-pi-url-reader

## 0.6.0

### Minor Changes

- 2798cbf: Require Node.js 26 or newer across all workspaces. CI, release workflows, and Docker stages now use Node.js 26. Node.js versions below 26 are no longer supported.

### Patch Changes

- Updated dependencies [2798cbf]
  - @narumitw/sumire-url-reader@0.25.0

## 0.5.0

### Minor Changes

- d97aaab: Rename the URL library and CLI to `@narumitw/sumire-url-reader` and `sumire-url-reader`, and rename the Pi integration to `@narumitw/sumire-pi-url-reader`. Move both URL skills into the Pi package and resolve the CLI through its declared library dependency. Update bot imports, Docker stages, and CI paths. Keep `read_url_content`, skill names, loader behavior, and source metadata unchanged. Hosts must update package imports and use the Pi package's `urlReaderSkillsPath` instead of the former skill path exports.

### Patch Changes

- Updated dependencies [d97aaab]
  - @narumitw/sumire-url-reader@0.24.0

## 0.4.0

### Minor Changes

- e9f5653: Rename the URL-reading tool from `load_public_url` to `read_url_content`. Update bot instructions, skills, documentation, and tests to use the new name. No legacy alias is registered; update direct calls, codemode scripts, and tool allowlists. Existing bot permissions are not transferred automatically: authorize the new name globally and in the effective chat policy through the Web UI.

### Patch Changes

- 48a5fab: Share bot URL loader configuration between article preloading and Pi tools. Make YouTube caption extraction explicit in the tool description and require a current tool failure before reporting unreadable captions. Add offline caption-loading and Pi tool-loop regression tests.
- Updated dependencies [426f3d7]
- Updated dependencies [9f3168d]
- Updated dependencies [e9f5653]
  - @narumitw/sumire-url-content@0.23.0

## 0.3.4

### Patch Changes

- 22bd32a: Route WallHop URLs directly to the existing automatic source-aware loader chain instead of accepting an HTTP 200 JavaScript challenge from the built-in loader. Preserve public-target validation and explicit loader overrides.
- 1059da4: Delegate every automatic URL load to the existing url-content source selection and fallback chain, including bot tool calls and article sources. Remove built-in-first routing, warning-text matching, and host exceptions from url-tool. Keep built-in extraction as an explicit override and preserve validation, deadlines, cancellation, output bounds, and attempt metadata. Pass the host's scheme policy through the one-shot API and reusable client so local redirects cannot bypass an HTTPS-only restriction; apply the same policy to reported Firecrawl final targets.
- Updated dependencies [1059da4]
  - @narumitw/sumire-url-content@0.22.4

## 0.3.3

### Patch Changes

- d914527: Prevent slow URL attempts from starving automatic fallback, prefer fast browser extraction, and share a total deadline across validation and built-in/source-aware loading. Article preloading now uses its configured budget and displays a reusable status before fetching. Preserve safe timeout/cancellation diagnostics and bound cleanup waiting. Add an opt-in final Firecrawl fallback, with streamed response limits and reported-target validation, without enabling external costs merely because an API key exists.
- 5b7a634: Update Pi dependencies to 0.99.1, Vitest to 5.0.3, taiwan-exchange-rates to 0.2.1, and fast-xml-parser to 5.11.2, and refresh the dependency lockfile. Align the bot's session interface with Pi's steering and follow-up return types.
- 93b032c: Update Pi dependencies to 1.0.0, Biome to 2.5.15, and Node.js type definitions to 26.6.4, and refresh the dependency lockfile.
- 2709cfb: Update Pi dependencies to 1.0.2 across all workspaces, update the bot's Otter CLI to 0.3.1 and Logfire Node to 0.18.27, and refresh the dependency lockfile.
- 5cb94f8: Update Pi and other workspace dependencies, including the dependency lockfile.
- Updated dependencies [d914527]
- Updated dependencies [b0ff41f]
- Updated dependencies [5b7a634]
- Updated dependencies [93b032c]
- Updated dependencies [2709cfb]
- Updated dependencies [5cb94f8]
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
