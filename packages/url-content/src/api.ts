import { UrlContentClient } from "./client.js"
import { runBounded } from "./core/interruption.js"
import type { LoadResult } from "./core/results.js"
import { explainLoadChain } from "./load-chain.js"
import { listLoaderNames } from "./loader-registry.js"

export interface LoadUrlOptions {
  deadlineSeconds?: number
  firecrawlFallback?: boolean
  loaderNames?: readonly string[]
  signal?: AbortSignal
}

export async function loadUrlDetailed(
  url: string,
  options: LoadUrlOptions = {},
): Promise<LoadResult> {
  const client = new UrlContentClient({ deadlineSeconds: options.deadlineSeconds }).start()
  // Cleanup continues cooperatively, but cannot indefinitely delay the result.
  const close = () => runBounded(() => client.close(), 5_000)
  let result: LoadResult
  try {
    result = await client.loadUrlDetailed(url, {
      ...(options.firecrawlFallback !== undefined
        ? { firecrawlFallback: options.firecrawlFallback }
        : {}),
      ...(options.loaderNames ? { loaderNames: options.loaderNames } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (error) {
    await close().catch(() => {})
    throw error
  }
  await close()
  return result
}

export async function loadUrl(url: string, options: LoadUrlOptions = {}): Promise<string> {
  return (await loadUrlDetailed(url, options)).content
}

export function availableLoaders(): string[] {
  return listLoaderNames()
}

export function explainPlan(url: string): Record<string, unknown> {
  return explainLoadChain(url).toObject()
}
