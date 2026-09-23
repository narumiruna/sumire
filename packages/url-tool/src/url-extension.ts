import type { ExtensionFactory } from "@earendil-works/pi-coding-agent"

import { createPublicUrlLoader, type PublicUrlLoaderOptions } from "./public-url.js"
import { createUrlTool, type UrlToolOptions } from "./url-tool.js"

export interface UrlExtensionOptions extends PublicUrlLoaderOptions, UrlToolOptions {}

export function createUrlExtension(options: UrlExtensionOptions = {}): ExtensionFactory {
  const { selectableLoaders, traceLoad, ...loaderOptions } = options
  return (pi) => {
    pi.registerTool(
      createUrlTool(createPublicUrlLoader(loaderOptions), {
        ...(selectableLoaders ? { selectableLoaders } : {}),
        ...(traceLoad ? { traceLoad } : {}),
      }),
    )
  }
}

export default createUrlExtension()
