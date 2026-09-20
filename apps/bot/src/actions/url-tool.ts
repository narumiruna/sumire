import { Type } from "@earendil-works/pi-ai"
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent"

import type { PublicUrlLoader } from "./public-url.js"

export function buildUrlTools(loader: PublicUrlLoader): ToolDefinition[] {
  return [
    defineTool({
      name: "load_public_url",
      label: "Load public URL",
      description:
        "Load readable text or Markdown from a public HTTP(S) URL. The bounded built-in loader is tried first, then the source-aware URL content loader handles source-specific or blocked content. Private, local, oversized, and unsafe redirect targets are rejected.",
      parameters: Type.Object({
        url: Type.String({ description: "The absolute public HTTP(S) URL to load" }),
      }),
      execute: async (_toolCallId, parameters, signal) => {
        const result = await loader.load(parameters.url, signal)
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        }
      },
    }),
  ]
}
