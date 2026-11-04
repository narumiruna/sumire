import { setTimeout as delay } from "node:timers/promises"
import type { StatusNotifications } from "@narumitw/sumire-policy"
import {
  readStatusIncident,
  readStatusSummary,
  type StatusProviderId,
  type StatusSummary,
} from "@narumitw/sumire-status-page"
import type { Api } from "grammy"
import type { AdminStore } from "../admin/store.js"
import type { Logger } from "../logging.js"
import {
  eventFingerprint,
  formatStatusNotification,
  impactRank,
  incidentEvent,
  type StatusEvent,
  summaryEvent,
} from "./events.js"
import { StatusDeliveryState } from "./state.js"

interface StatusWorkerOptions {
  store: Pick<AdminStore, "snapshot" | "db">
  send(chatId: number, text: string, signal: AbortSignal): Promise<void>
  logger: Pick<Logger, "warn">
  readSummary?: typeof readStatusSummary
  readIncident?: typeof readStatusIncident
}

const idleSeconds = 60
const maxRecoveryChecks = 12

/** No model turns. Each selected destination has an independent durable acknowledgement. */
export class StatusNotificationWorker {
  readonly #controller = new AbortController()
  readonly #state: StatusDeliveryState
  readonly #recoveryOffsets = new Map<StatusProviderId, number>()
  #active: Promise<number> | undefined
  #loop: Promise<void> | undefined
  #closed: Promise<void> | undefined
  #lastSend = 0

  constructor(private readonly options: StatusWorkerOptions) {
    this.#state = new StatusDeliveryState(options.store.db)
  }

  start() {
    this.#loop ??= this.#run()
  }

  async #run() {
    while (!this.#controller.signal.aborted) {
      let seconds = idleSeconds
      try {
        seconds = await this.poll()
      } catch {
        if (!this.#controller.signal.aborted)
          this.options.logger.warn("Service status polling failed; delivery checkpoints retained")
      }
      try {
        await delay(seconds * 1000, undefined, { signal: this.#controller.signal })
      } catch {
        break
      }
    }
  }

  /** Polls cannot overlap, including calls made by lifecycle tests. */
  poll(): Promise<number> {
    if (this.#active) return Promise.reject(new Error("Service status poll is already active"))
    this.#active = this.#poll().finally(() => {
      this.#active = undefined
    })
    return this.#active
  }

  async #poll(): Promise<number> {
    this.#controller.signal.throwIfAborted()
    const initial = this.options.store.snapshot()
    const settings = initial.policy.statusNotifications
    if (initial.status !== "applied" || initial.applied !== initial.revision) return idleSeconds
    this.#state.prune(settings.chatIds, settings.providers, Date.now())
    if (!settings.enabled || !settings.providers.length || !settings.chatIds.length)
      return idleSeconds

    const operation = new AbortController()
    const signal = AbortSignal.any([this.#controller.signal, operation.signal])
    const authorize = () => {
      signal.throwIfAborted()
      const current = this.options.store.snapshot()
      if (
        current.status !== "applied" ||
        current.applied !== current.revision ||
        current.revision !== initial.revision ||
        current.epoch !== initial.epoch
      ) {
        operation.abort()
        throw new Error("Service status settings changed during polling")
      }
    }
    // Settings have no change stream. Also cancel in-flight HTTP and Telegram operations.
    const guard = setInterval(() => {
      try {
        authorize()
      } catch {
        operation.abort()
      }
    }, 1000)
    try {
      const results = await Promise.allSettled(
        settings.providers.map((provider) =>
          (this.options.readSummary ?? readStatusSummary)(provider, { signal }),
        ),
      )
      authorize()
      for (const [index, result] of results.entries()) {
        const provider = settings.providers[index]
        if (!provider) continue
        if (result.status === "rejected") {
          this.options.logger.warn(`Could not read ${provider} service status`)
          continue
        }
        const summary = result.value
        const events = await this.#events(summary, settings, signal, authorize)
        authorize()
        const hasActiveIncidents = events.some((event) => event.kind === "incident" && event.active)
        const hasActiveMaintenance = events.some(
          (event) => event.kind === "maintenance" && event.active,
        )
        const confirmedHealthyComponents = summary.components.every(
          (component) =>
            component.status === "operational" ||
            (!settings.includeMaintenance && component.status === "under_maintenance"),
        )
        for (const event of events) {
          for (const chatId of settings.chatIds) {
            authorize()
            // Prefer detailed incidents over a second aggregate alert. Existing aggregate
            // checkpoints stay active until the summary itself confirms recovery.
            if (event.kind === "summary") {
              if (!event.active && !confirmedHealthyComponents) continue
              if (
                event.active &&
                (hasActiveIncidents || (event.maintenance && hasActiveMaintenance))
              )
                continue
            }
            await this.#deliver(provider, event, chatId, settings, signal, authorize)
          }
        }
      }
      return settings.pollIntervalSeconds
    } finally {
      clearInterval(guard)
    }
  }

  async #events(
    summary: StatusSummary,
    settings: StatusNotifications,
    signal: AbortSignal,
    authorize: () => void,
  ) {
    const events = [
      ...summary.incidents
        .map((incident) => incidentEvent(incident))
        .filter((event) => !event.maintenance || settings.includeMaintenance),
      ...(settings.includeMaintenance
        ? summary.maintenances.map((incident) => incidentEvent(incident, true))
        : []),
      summaryEvent(summary, settings.includeMaintenance),
    ]
    const present = new Set(events.map((event) => event.id))
    const missing = [
      ...new Set(
        this.#state
          .active(summary.provider)
          .filter(
            (record) =>
              record.eventId !== "summary" &&
              !present.has(record.eventId) &&
              (!record.maintenance || settings.includeMaintenance),
          )
          .map((record) => record.eventId),
      ),
    ]
    // A bounded round-robin scan prevents one permanently missing incident from blocking others.
    const offset = (this.#recoveryOffsets.get(summary.provider) ?? 0) % (missing.length || 1)
    const checks = [...missing.slice(offset), ...missing.slice(0, offset)].slice(
      0,
      maxRecoveryChecks,
    )
    this.#recoveryOffsets.set(summary.provider, offset + checks.length)
    for (let index = 0; index < checks.length; index += 4) {
      authorize()
      const results = await Promise.allSettled(
        checks.slice(index, index + 4).map(async (key) => {
          const id = key.slice(key.indexOf(":") + 1)
          const incident = await (this.options.readIncident ?? readStatusIncident)(
            summary.provider,
            id,
            {
              signal,
            },
          )
          if (incident.id !== id) throw new Error("Status incident identity does not match")
          return incidentEvent(incident, key.startsWith("maintenance:"))
        }),
      )
      for (const result of results) {
        if (result.status === "fulfilled") events.push(result.value)
        else this.options.logger.warn(`Could not confirm ${summary.provider} incident status`)
      }
    }
    return events
  }

  async #deliver(
    provider: StatusProviderId,
    event: StatusEvent,
    chatId: number,
    settings: StatusNotifications,
    signal: AbortSignal,
    authorize: () => void,
  ) {
    const checkpoint = this.#state.get(chatId, provider, event.id)
    const fingerprint = eventFingerprint(event)
    if (checkpoint?.fingerprint === fingerprint) return
    if (!event.active && !checkpoint?.active) return
    if (!event.active && checkpoint?.maintenance && !settings.includeMaintenance) return
    if (
      event.active &&
      !event.maintenance &&
      impactRank[event.impact as keyof typeof impactRank] < impactRank[settings.minimumImpact]
    )
      return
    const change = !event.active
      ? "resolved"
      : checkpoint?.active && Boolean(checkpoint.maintenance) === event.maintenance
        ? "update"
        : "new"
    const suppressed =
      (change === "update" && !settings.notifyUpdates) ||
      (change === "resolved" && !settings.notifyResolved)
    if (!suppressed) {
      // Limit this worker to ten send attempts per second across all destinations and providers.
      const nextSend = this.#lastSend + 100
      while (Date.now() < nextSend) {
        await delay(nextSend - Date.now(), undefined, { signal })
      }
      authorize()
      this.#lastSend = Date.now()
      try {
        await this.options.send(
          chatId,
          formatStatusNotification(provider, event, change),
          AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        )
      } catch {
        authorize()
        this.options.logger.warn(`Could not deliver ${provider} service status to chat ${chatId}`)
        return
      }
      authorize()
    }
    this.#state.acknowledge(
      chatId,
      provider,
      event.id,
      fingerprint,
      event.active,
      event.maintenance,
      Date.now(),
    )
  }

  close(): Promise<void> {
    this.#closed ??= (async () => {
      this.#controller.abort()
      await Promise.allSettled([this.#loop, this.#active])
    })()
    return this.#closed
  }
}

export function startStatusNotificationWorker(
  store: AdminStore,
  api: Pick<Api, "sendMessage">,
  logger: Pick<Logger, "warn">,
): StatusNotificationWorker {
  const worker = new StatusNotificationWorker({
    store,
    logger,
    send: async (chatId, text, signal) => {
      await api.sendMessage(
        chatId,
        text,
        { link_preview_options: { is_disabled: true } },
        signal as unknown as Parameters<typeof api.sendMessage>[3],
      )
    },
  })
  worker.start()
  return worker
}
