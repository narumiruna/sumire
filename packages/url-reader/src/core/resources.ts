import type { Session as ImpersSession } from "impers"
import type { Browser } from "playwright"
import type { NodeImpersTransport } from "./impers-transport.js"

export type { ImpersSession }

export interface ResourceProvider {
  validateUrl(input: string | URL, signal?: AbortSignal): Promise<URL>
  fetch(input: string | URL, init?: RequestInit): Promise<Response>
  impersSession(): Promise<ImpersSession>
  impersTransport?(): Promise<NodeImpersTransport>
  impersProxy(): Promise<string>
  browser(): Promise<Browser>
  runBrowser<T>(operation: () => Promise<T>): Promise<T>
  runWorker<T>(operation: () => Promise<T>): Promise<T>
}
