import type { ServiceStatusCatalog } from "@narumitw/sumire-contracts"
import {
  readStatusSummary,
  type StatusProviderId,
  type StatusSummary,
} from "@narumitw/sumire-status-page"
import { withStatusSignal } from "./operations.js"
import type { StatusDeliveryState } from "./state.js"

interface PendingCatalogRead {
  work: Promise<StatusSummary>
  controller: AbortController
  consumers: number
}

interface CatalogEntry {
  checkedAt: number
  fetchedAt: number | null
  summary?: StatusSummary
  failed: boolean
}

/** Shared fixed-source reads. A failed refresh never supplies stale data to the worker. */
export class StatusCatalog {
  readonly #entries = new Map<StatusProviderId, CatalogEntry>()
  readonly #pending = new Map<StatusProviderId, PendingCatalogRead>()

  constructor(
    private readonly options: {
      state: Pick<StatusDeliveryState, "recordSource">
      signal: AbortSignal
      now(): number
      readSummary?: typeof readStatusSummary
    },
  ) {}

  async read(
    provider: StatusProviderId,
    signal: AbortSignal,
    force = false,
  ): Promise<StatusSummary> {
    signal.throwIfAborted()
    this.options.signal.throwIfAborted()
    const entry = this.#entries.get(provider)
    if (!force && entry && this.options.now() - entry.checkedAt < 60_000) {
      if (entry.failed || !entry.summary) throw new Error("Service status source is unavailable")
      return entry.summary
    }
    let pending = this.#pending.get(provider)
    if (!pending) {
      const controller = new AbortController()
      const combined = AbortSignal.any([controller.signal, this.options.signal])
      const work: Promise<StatusSummary> = this.#load(provider, combined).finally(() => {
        if (this.#pending.get(provider)?.work === work) this.#pending.delete(provider)
      })
      pending = { work, controller, consumers: 0 }
      this.#pending.set(provider, pending)
    }
    pending.consumers++
    try {
      const summary = await withStatusSignal(pending.work, signal)
      signal.throwIfAborted()
      return summary
    } finally {
      pending.consumers--
      if (pending.consumers === 0 && this.#pending.get(provider) === pending) {
        this.#pending.delete(provider)
        pending.controller.abort()
      }
    }
  }

  async #load(provider: StatusProviderId, signal: AbortSignal): Promise<StatusSummary> {
    try {
      const summary = await withStatusSignal(
        (this.options.readSummary ?? readStatusSummary)(provider, { signal }),
        signal,
      )
      signal.throwIfAborted()
      if (summary.provider !== provider) throw new Error("Status provider identity does not match")
      const now = this.options.now()
      this.#entries.set(provider, { checkedAt: now, fetchedAt: now, summary, failed: false })
      this.options.state.recordSource(provider, true, now)
      return summary
    } catch (error) {
      // Caller cancellation is not a source outage and must not poison the shared cache.
      if (signal.aborted && error instanceof Error && error.name === "AbortError") throw error
      const previous = this.#entries.get(provider)
      this.#entries.set(provider, {
        checkedAt: this.options.now(),
        fetchedAt: previous?.fetchedAt ?? null,
        ...(previous?.summary ? { summary: previous.summary } : {}),
        failed: true,
      })
      this.options.state.recordSource(
        provider,
        false,
        this.options.now(),
        signal.aborted ? "cancelled" : "source_unavailable",
      )
      throw error
    }
  }

  async settled(): Promise<void> {
    await Promise.allSettled([...this.#pending.values()].map((entry) => entry.work))
  }

  async components(provider: StatusProviderId, signal: AbortSignal): Promise<ServiceStatusCatalog> {
    try {
      await this.read(provider, signal)
    } catch {
      signal.throwIfAborted()
      this.options.signal.throwIfAborted()
    }
    const entry = this.#entries.get(provider)
    return {
      provider,
      components: entry?.summary?.components ?? [],
      fetchedAt: entry?.fetchedAt ?? null,
      stale: !entry || entry.failed || this.options.now() - entry.checkedAt >= 60_000,
      error: !entry || entry.failed ? "source_unavailable" : null,
    }
  }
}
