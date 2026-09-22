import { StringEnum, Type } from "@earendil-works/pi-ai"
import { defineTool } from "@earendil-works/pi-coding-agent"

import {
  assertUrlLoaderName,
  type PublicUrlLoader,
  type PublicUrlLoadOptions,
} from "./public-url.js"

export interface UrlToolOptions {
  selectableLoaders?: readonly string[]
}

export function createUrlTool(loader: PublicUrlLoader, options: UrlToolOptions = {}) {
  const selectableLoaders = normalizeSelectableLoaders(options.selectableLoaders)
  const allowedLoaders = new Set(selectableLoaders)
  const parameters = Type.Object({
    url: Type.String({ description: "The absolute public HTTP(S) URL to load" }),
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

  return defineTool({
    name: "load_public_url",
    label: "Load public URL",
    description:
      "Load readable text or Markdown from a public HTTP(S) URL. Google Docs links use plain-text export; Office, OpenDocument, RTF, EPUB, and CSV links use local AnyDoc conversion. Other URLs try the bounded built-in loader first, then source-aware extraction for source-specific or blocked content. Private, local, oversized, and unsafe redirect targets are rejected.",
    parameters,
    execute: async (_toolCallId, toolParameters, signal) => {
      const rawLoader = "loader" in toolParameters ? toolParameters.loader : undefined
      if (rawLoader !== undefined && typeof rawLoader !== "string") {
        throw new TypeError("URL loader must be a string")
      }
      const requestedLoader = rawLoader
      if (requestedLoader !== undefined && !allowedLoaders.has(requestedLoader)) {
        throw new Error(`URL loader is not selectable: ${requestedLoader}`)
      }
      const loadOptions: PublicUrlLoadOptions = {
        ...(requestedLoader !== undefined ? { loader: requestedLoader } : {}),
        ...(signal ? { signal } : {}),
      }
      const result = await loader.load(toolParameters.url, loadOptions)
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
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
