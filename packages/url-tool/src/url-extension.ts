import type { ExtensionFactory } from "@earendil-works/pi-coding-agent"

import { createPublicUrlLoader, type PublicUrlLoaderOptions } from "./public-url.js"
import { createUrlTool } from "./url-tool.js"

export function createUrlExtension(options: PublicUrlLoaderOptions = {}): ExtensionFactory {
  return (pi) => {
    pi.registerTool(createUrlTool(createPublicUrlLoader(options)))
  }
}

export default createUrlExtension()
