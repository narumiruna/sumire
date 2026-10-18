import { StringEnum, Type } from "@earendil-works/pi-ai"
import { defineTool } from "@earendil-works/pi-coding-agent"
import {
  assertUrlLoaderName,
  type LoadedUrl,
  type PublicUrlLoader,
  type PublicUrlLoadOptions,
} from "./public-url.js"
import { normalizeUrlFailure, PublicUrlError, type UrlFailure } from "./url-failure.js"

export interface UrlToolOptions {
  selectableLoaders?: readonly string[]
  traceLoad?: (
    url: string,
    loader: string | undefined,
    toolCallId: string,
    load: () => Promise<LoadedUrl>,
  ) => Promise<LoadedUrl>
}

export function createUrlTool(loader: PublicUrlLoader, options: UrlToolOptions = {}) {
  const selectableLoaders = normalizeSelectableLoaders(options.selectableLoaders)
  const allowedLoaders = new Set(selectableLoaders)
  const parameters = Type.Object({
    url: Type.String({ description: "The absolute public HTTP(S) URL to read" }),
    ...(selectableLoaders.length > 0
      ? {
          loader: Type.Optional(
            StringEnum(selectableLoaders, {
              description:
                "Optional exact loader override. Omit it for automatic selection; explicit loaders do not fall back.",
            }),
          ),
        }
      : {}),
  })

  return defineTool<typeof parameters, LoadedUrl | UrlFailure>({
    name: "read_url_content",
    label: "Read URL content",
    description:
      "Read text or Markdown from a public HTTP(S) URL. Use this tool to read, summarize, or inspect a supplied URL before answering from its content. YouTube watch, Shorts, and youtu.be links use caption extraction first, with audio transcription fallback; call with only url for automatic selection. A video URL is not a reason to assume captions are unavailable. Google Docs links use plain-text export; Threads post and share links require verified post metadata; Office, OpenDocument, RTF, EPUB, and CSV links use local AnyDoc conversion. Automatic loading delegates directly to url-reader source selection and fallback; built-in extraction runs only when explicitly selected. Private, local, oversized, and unsafe redirect targets are rejected.",
    parameters,
    execute: async (toolCallId, toolParameters, signal) => {
      try {
        signal?.throwIfAborted()
        const rawLoader = "loader" in toolParameters ? toolParameters.loader : undefined
        if (rawLoader !== undefined && typeof rawLoader !== "string") {
          throw new PublicUrlError("unknown", "URL loader must be a string")
        }
        const requestedLoader = rawLoader
        if (requestedLoader !== undefined && !allowedLoaders.has(requestedLoader)) {
          throw new PublicUrlError("unknown", "URL loader is not selectable")
        }
        const loadOptions: PublicUrlLoadOptions = {
          ...(requestedLoader !== undefined ? { loader: requestedLoader } : {}),
          ...(signal ? { signal } : {}),
        }
        const load = () => loader.load(toolParameters.url, loadOptions)
        const result = await (options.traceLoad
          ? options.traceLoad(toolParameters.url, requestedLoader, toolCallId, load)
          : load())
        signal?.throwIfAborted()
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        }
      } catch (error) {
        // Cancellation is control flow. Preserve the caller's original reason and identity.
        signal?.throwIfAborted()
        const failure = normalizeUrlFailure(error, toolParameters.url)
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(failure) }],
          details: failure,
        }
      }
    },
  })
}

function normalizeSelectableLoaders(loaders: readonly string[] = []): string[] {
  const normalized = [...new Set(loaders)]
  for (const loader of normalized) {
    if (!loader || loader.trim() !== loader) {
      throw new Error(`Invalid selectable URL loader: ${JSON.stringify(loader)}`)
    }
    assertUrlLoaderName(loader)
  }
  return normalized
}
