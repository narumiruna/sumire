import { UrlContentClient } from "./client.js"
import type { LoadResult } from "./core/results.js"
import { explainLoadChain } from "./load-chain.js"
import { listLoaderNames } from "./loader-registry.js"

export interface LoadUrlOptions {
  deadlineSeconds?: number
  loaderNames?: readonly string[]
  signal?: AbortSignal
}

export async function loadUrlDetailed(
  url: string,
  options: LoadUrlOptions = {},
): Promise<LoadResult> {
  const client = new UrlContentClient({ deadlineSeconds: options.deadlineSeconds }).start()
  try {
    return await client.loadUrlDetailed(url, {
      ...(options.loaderNames ? { loaderNames: options.loaderNames } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } finally {
    await client.close()
  }
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
