import { createHash } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import type {
  ServiceStatusDeliveryResponse,
  ServiceStatusProviderId,
  ServiceStatusTestRequest,
  ServiceStatusTestResult,
} from "@narumitw/sumire-contracts"
import {
  resolveStatusSubscription,
  type StatusNotifications,
  type StatusSubscription,
} from "@narumitw/sumire-policy"
import {
  readStatusIncident,
  type StatusProviderId,
  type StatusSummary,
} from "@narumitw/sumire-status-page"
import type { Api } from "grammy"
import { AdminError, type AdminStore } from "../admin/store.js"
import type { Logger } from "../logging.js"
import { StatusCatalog } from "./catalog.js"
import {
  eventFingerprint,
  formatStatusNotification,
  impactRank,
  incidentEvent,
  type StatusEvent,
} from "./events.js"
import { scopeStatusEvents } from "./filter.js"
import { statusDiagnostic, withStatusSignal } from "./operations.js"
import { quietUntil, statusRuleFingerprint } from "./schedule.js"
import { type PendingStatusNotification, StatusDeliveryState } from "./state.js"

export interface StatusWorkerClock {
  now(): number
  monotonic(): number
  wait(milliseconds: number, signal: AbortSignal): Promise<void>
}

export interface StatusDeliveryQuery {
  offset: number
  limit: number
  chatId?: number
  provider?: ServiceStatusProviderId | "test"
}

export interface StatusWorkerOptions {
  store: Pick<AdminStore, "snapshot" | "db" | "audit">
  send(chatId: number, text: string, signal: AbortSignal): Promise<void>
  logger: Pick<Logger, "warn">
  readSummary?: ConstructorParameters<typeof StatusCatalog>[0]["readSummary"]
  readIncident?: typeof readStatusIncident
  clock?: StatusWorkerClock
}

interface TestContext {
  actor: string
  signal: AbortSignal
  authorize(): void
}

type Snapshot = ReturnType<StatusWorkerOptions["store"]["snapshot"]>
class QuietWindowStarted extends Error {
  constructor(readonly until: number) {
    super("Service status quiet window started")
  }
}

const idleSeconds = 60
const maxRecoveryChecks = 12
const key = (chatId: number, provider: StatusProviderId, eventId: string) =>
  `${chatId}:${provider}:${eventId}`
const isAggregate = (id: string) => id === "summary" || id.startsWith("summary:")
const points = (value: string, maximum: number) => Array.from(value).slice(0, maximum).join("")

/** One service owns polling, durable delivery, manual tests, and the shared transport limit. */
export class StatusNotificationWorker {
  readonly #controller = new AbortController()
  readonly #state: StatusDeliveryState
  readonly #catalog: StatusCatalog
  readonly #clock: StatusWorkerClock
  readonly #recoveryOffsets = new Map<StatusProviderId, number>()
  readonly #failedProviders = new Set<StatusProviderId>()
  readonly #blockedEvents = new Set<string>()
  readonly #tests = new Set<Promise<ServiceStatusTestResult>>()
  readonly #testChats = new Set<number>()
  #active: Promise<number> | undefined
  #flushing: Promise<void> | undefined
  #loop: Promise<void> | undefined
  #closed: Promise<void> | undefined
  #sleep: AbortController | undefined
  #sendTail: Promise<void> = Promise.resolve()
  #nextSend = 0
  #nextPollAt = 0

  constructor(private readonly options: StatusWorkerOptions) {
    this.#clock = options.clock ?? {
      now: () => Date.now(),
      monotonic: () => performance.now(),
      wait: async (milliseconds, signal) => {
        await delay(milliseconds, undefined, { signal })
      },
    }
    this.#state = new StatusDeliveryState(options.store.db)
    this.#catalog = new StatusCatalog({
      state: this.#state,
      signal: this.#controller.signal,
      now: () => this.#clock.now(),
      ...(options.readSummary ? { readSummary: options.readSummary } : {}),
    })
  }

  start() {
    this.#loop ??= this.#run()
  }

  /** Applied settings can change the next poll or a quiet-window boundary. */
  wake() {
    this.#nextPollAt = this.#clock.now()
    this.#sleep?.abort()
  }

  async #run() {
    while (!this.#controller.signal.aborted) {
      try {
        if (this.#clock.now() >= this.#nextPollAt) await this.poll()
        else await this.flush()
      } catch {
        this.#nextPollAt = this.#clock.now() + idleSeconds * 1000
        if (!this.#controller.signal.aborted)
          this.options.logger.warn("Service status polling failed; delivery checkpoints retained")
      }
      if (this.#controller.signal.aborted) break
      const applied = this.#applied()
      const due = applied?.policy.statusNotifications.enabled ? this.#state.nextDue() : undefined
      const next = Math.min(this.#nextPollAt, due ?? Number.POSITIVE_INFINITY)
      this.#sleep = new AbortController()
      try {
        await this.#clock.wait(
          Math.max(1, next - this.#clock.now()),
          AbortSignal.any([this.#controller.signal, this.#sleep.signal]),
        )
      } catch {
        if (this.#controller.signal.aborted) break
      } finally {
        this.#sleep = undefined
      }
    }
  }

  #assertOpen() {
    if (this.#controller.signal.aborted) throw new AdminError(503, "Service status is stopping")
  }

  #applied(): Snapshot | undefined {
    const current = this.options.store.snapshot()
    return current.status === "applied" && current.applied === current.revision
      ? current
      : undefined
  }

  #subscriptions(settings: StatusNotifications) {
    return settings.chatIds.flatMap((chatId) => {
      const subscription = resolveStatusSubscription(settings, chatId)
      return subscription ? [subscription] : []
    })
  }

  #prune(settings: StatusNotifications) {
    const subscriptions = this.#subscriptions(settings)
    this.#state.pruneSubscriptions(
      subscriptions.map((subscription) => ({
        chatId: subscription.chatId,
        providers: subscription.providers,
        ruleFingerprint: statusRuleFingerprint(subscription),
      })),
      settings.enabled,
      this.#clock.now(),
    )
    return subscriptions
  }

  async #operation<T>(
    initial: Snapshot,
    work: (signal: AbortSignal, authorize: () => void) => Promise<T>,
    context?: TestContext,
  ): Promise<T> {
    const operation = new AbortController()
    const signal = AbortSignal.any([
      this.#controller.signal,
      operation.signal,
      ...(context ? [context.signal] : []),
    ])
    const authorize = () => {
      this.#assertOpen()
      context?.authorize()
      const current = this.#applied()
      if (!current || current.revision !== initial.revision || current.epoch !== initial.epoch) {
        operation.abort()
        throw new AdminError(409, "Service status settings changed; reload before retrying")
      }
      signal.throwIfAborted()
    }
    const guard = setInterval(() => {
      try {
        authorize()
      } catch {
        operation.abort()
      }
    }, 1000)
    try {
      authorize()
      return await work(signal, authorize)
    } finally {
      clearInterval(guard)
    }
  }

  /** Exposed for deterministic tests. Polls cannot overlap. */
  poll(): Promise<number> {
    if (this.#active || this.#flushing)
      return Promise.reject(new Error("Service status poll is already active"))
    this.#active = this.#poll().finally(() => {
      this.#active = undefined
    })
    return this.#active
  }

  async #poll(): Promise<number> {
    this.#controller.signal.throwIfAborted()
    const initial = this.#applied()
    if (!initial) {
      this.#nextPollAt = this.#clock.now() + idleSeconds * 1000
      return idleSeconds
    }
    const settings = initial.policy.statusNotifications
    const subscriptions = this.#prune(settings)
    const providers = [...new Set(subscriptions.flatMap((subscription) => subscription.providers))]
    if (!settings.enabled || !providers.length) {
      this.#nextPollAt = this.#clock.now() + idleSeconds * 1000
      return idleSeconds
    }
    this.#blockedEvents.clear()
    await this.#operation(initial, async (signal, authorize) => {
      const results = await Promise.allSettled(
        providers.map((provider) => this.#catalog.read(provider, signal, true)),
      )
      authorize()
      for (const [index, result] of results.entries()) {
        const provider = providers[index]
        if (!provider) continue
        if (result.status === "rejected") {
          this.#failedProviders.add(provider)
          this.options.logger.warn(`Could not read ${provider} service status`)
          continue
        }
        this.#failedProviders.delete(provider)
        const summary = result.value
        const details = await this.#details(summary, settings, signal, authorize)
        authorize()
        for (const subscription of subscriptions.filter((entry) =>
          entry.providers.includes(provider),
        )) {
          const retained = new Map(
            this.#state
              .active(provider)
              .filter((entry) => entry.chatId === subscription.chatId && entry.components)
              .map((entry) => [entry.eventId, entry.components ?? []]),
          )
          for (const pending of this.#state.pending(subscription.chatId, provider))
            retained.set(pending.eventId, pending.event.components)
          const selection = subscription.componentSelections[provider]
          const aggregateId =
            selection === null
              ? "summary"
              : `summary:${createHash("sha256")
                  .update(JSON.stringify([...selection].sort()))
                  .digest("hex")
                  .slice(0, 16)}`
          for (const checkpoint of this.#state.active(provider)) {
            if (
              checkpoint.chatId === subscription.chatId &&
              isAggregate(checkpoint.eventId) &&
              checkpoint.eventId !== aggregateId
            )
              this.#state.forget(subscription.chatId, provider, checkpoint.eventId)
          }
          const priorAggregate = retained.get(aggregateId)
          if (priorAggregate) retained.set("summary", priorAggregate)
          const events = scopeStatusEvents(summary, details, subscription, retained)
          this.#reconcile(summary, details, events, subscription, retained, aggregateId)
          for (const event of events) {
            authorize()
            this.#observe(
              provider,
              event.kind === "summary" ? { ...event, id: aggregateId } : event,
              subscription,
            )
          }
        }
      }
      await this.#flush(settings, signal, authorize)
    })
    this.#nextPollAt = this.#clock.now() + settings.pollIntervalSeconds * 1000
    return settings.pollIntervalSeconds
  }

  async #details(
    summary: StatusSummary,
    settings: StatusNotifications,
    signal: AbortSignal,
    authorize: () => void,
  ): Promise<StatusEvent[]> {
    const events = [
      ...summary.incidents.map((incident) => incidentEvent(incident)),
      ...(settings.includeMaintenance
        ? summary.maintenances.map((incident) => incidentEvent(incident, true))
        : []),
    ].filter((event) => !event.maintenance || settings.includeMaintenance)
    const present = new Set(events.map((event) => event.id))
    const pending = this.#state.pending(undefined, summary.provider)
    const known = [
      ...this.#state.active(summary.provider),
      ...pending.map((row) => ({
        eventId: row.eventId,
        maintenance: Number(row.event.maintenance),
      })),
    ]
    const missing = [
      ...new Set(
        known
          .filter(
            (entry) =>
              !isAggregate(entry.eventId) &&
              !present.has(entry.eventId) &&
              (!entry.maintenance || settings.includeMaintenance),
          )
          .map((entry) => entry.eventId),
      ),
    ]
    const offset = (this.#recoveryOffsets.get(summary.provider) ?? 0) % (missing.length || 1)
    const checks = [...missing.slice(offset), ...missing.slice(0, offset)].slice(
      0,
      maxRecoveryChecks,
    )
    this.#recoveryOffsets.set(summary.provider, offset + checks.length)
    for (let index = 0; index < checks.length; index += 4) {
      authorize()
      const results = await Promise.allSettled(
        checks.slice(index, index + 4).map(async (eventId) => {
          const id = eventId.slice(eventId.indexOf(":") + 1)
          const incident = await withStatusSignal(
            (this.options.readIncident ?? readStatusIncident)(summary.provider, id, { signal }),
            signal,
          )
          if (incident.id !== id) throw new Error("Status incident identity does not match")
          return incidentEvent(incident, eventId.startsWith("maintenance:"))
        }),
      )
      for (const result of results) {
        if (result.status === "fulfilled") events.push(result.value)
        else this.options.logger.warn(`Could not confirm ${summary.provider} incident status`)
      }
    }
    return events
  }

  #reconcile(
    summary: StatusSummary,
    details: readonly StatusEvent[],
    events: readonly StatusEvent[],
    subscription: StatusSubscription,
    retained: ReadonlyMap<string, readonly StatusEvent["components"][number][]>,
    aggregateId: string,
  ) {
    const visible = new Set(
      events.map((event) => (event.kind === "summary" ? aggregateId : event.id)),
    )
    const selection = subscription.componentSelections[summary.provider]
    const catalog = new Set(summary.components.map((component) => component.id))
    const complete = selection === null || selection.every((id) => catalog.has(id))
    const baseline = scopeStatusEvents(summary, [], subscription, retained).find(
      (event) => event.kind === "summary",
    )
    for (const row of this.#state.pending(subscription.chatId, summary.provider)) {
      if (visible.has(row.eventId) || !row.event.active) continue
      const raw = details.find((event) => event.id === row.eventId)
      const excluded =
        raw &&
        raw.components.length > 0 &&
        complete &&
        raw.components.every((component) => catalog.has(component.id))
      const covered =
        isAggregate(row.eventId) &&
        baseline?.active &&
        !events.some((event) => event.kind === "summary")
      if (excluded || covered) this.#state.clearPending(row.chatId, row.provider, row.eventId)
      else this.#blockedEvents.add(key(row.chatId, row.provider, row.eventId))
    }
  }

  #observe(provider: StatusProviderId, event: StatusEvent, subscription: StatusSubscription) {
    const chatId = subscription.chatId
    const checkpoint = this.#state.get(chatId, provider, event.id)
    const pending = this.#state.pendingGet(chatId, provider, event.id)
    const fingerprint = eventFingerprint(event)
    // A matching current state can still have deferred peak or occurrence history.
    if (checkpoint?.fingerprint === fingerprint && !pending) return
    if (pending?.fingerprint === fingerprint) return
    if (!event.active && !checkpoint?.active && !pending?.initial) return
    if (
      !event.active &&
      (checkpoint?.maintenance || pending?.event.maintenance) &&
      !subscription.includeMaintenance
    )
      return
    const belowThreshold =
      event.active &&
      !event.maintenance &&
      impactRank[event.impact as keyof typeof impactRank] < impactRank[subscription.minimumImpact]
    if (belowThreshold && !pending) return
    const change = !event.active
      ? "resolved"
      : checkpoint?.active && Boolean(checkpoint.maintenance) === event.maintenance
        ? "update"
        : "new"
    if (
      (change === "update" && !subscription.notifyUpdates) ||
      (change === "resolved" && !subscription.notifyResolved)
    ) {
      this.#state.acknowledge(
        chatId,
        provider,
        event.id,
        fingerprint,
        event.active,
        event.maintenance,
        this.#clock.now(),
        {
          components: event.components,
          impact: event.impact,
        },
      )
      this.#state.clearPending(chatId, provider, event.id)
      return
    }
    const now = this.#clock.now()
    const quiet = quietUntil(subscription.quietHours, now)
    const oldImpact = checkpoint?.impact
    const escalated =
      !event.maintenance &&
      oldImpact &&
      oldImpact !== "maintenance" &&
      impactRank[event.impact as keyof typeof impactRank] > impactRank[oldImpact]
    const dueAt =
      quiet !== null
        ? Math.max(quiet, pending?.dueAt ?? 0)
        : change === "update" && !escalated && subscription.batchWindowSeconds
          ? (pending?.dueAt ?? now + subscription.batchWindowSeconds * 1000)
          : now
    let observedImpact = event.maintenance ? undefined : event.impact
    const previousImpact = pending?.event.observedImpact ?? pending?.event.impact
    if (
      observedImpact &&
      previousImpact &&
      previousImpact !== "maintenance" &&
      impactRank[previousImpact] > impactRank[observedImpact as keyof typeof impactRank]
    )
      observedImpact = previousImpact
    const snapshot: StatusEvent = {
      ...event,
      ...(observedImpact ? { observedImpact } : {}),
      name: points(event.name, 200),
      body: points(event.body, 1024),
      components: event.components.map((component) => ({
        ...component,
        name: points(component.name, 80),
      })),
    }
    const accepted = this.#state.admit({
      chatId,
      provider,
      eventId: event.id,
      fingerprint,
      event: snapshot,
      change,
      dueAt,
      firstSeenAt: pending?.firstSeenAt ?? now,
      changes: (pending?.changes ?? 0) + 1,
      ruleFingerprint: statusRuleFingerprint(subscription),
      initial: pending?.initial ?? !checkpoint?.active,
    })
    if (!accepted) {
      if (pending) this.#blockedEvents.add(key(chatId, provider, event.id))
      this.#state.recordDelivery(chatId, provider, false, now, "queue_full")
    }
  }

  flush(): Promise<void> {
    if (this.#flushing) return this.#flushing
    if (this.#active) return this.#active.then(() => {})
    this.#flushing = (async () => {
      this.#controller.signal.throwIfAborted()
      const initial = this.#applied()
      if (!initial) return
      this.#prune(initial.policy.statusNotifications)
      if (!initial.policy.statusNotifications.enabled) return
      await this.#operation(initial, (signal, authorize) =>
        this.#flush(initial.policy.statusNotifications, signal, authorize),
      )
    })().finally(() => {
      this.#flushing = undefined
    })
    return this.#flushing
  }

  #postpone(row: PendingStatusNotification, dueAt: number) {
    if (this.#state.pendingGet(row.chatId, row.provider, row.eventId)?.version === row.version)
      this.#state.admit({ ...row, dueAt })
  }

  async #flush(settings: StatusNotifications, signal: AbortSignal, authorize: () => void) {
    const ready = this.#state
      .due(this.#clock.now(), 100)
      .sort((a, b) => a.dueAt - b.dueAt || a.version - b.version)
    const groups = new Map<number, PendingStatusNotification[]>()
    const batches: { chatId: number; rows: PendingStatusNotification[] }[] = []
    for (const row of ready) {
      authorize()
      const subscription = resolveStatusSubscription(settings, row.chatId)
      if (
        !subscription?.providers.includes(row.provider) ||
        statusRuleFingerprint(subscription) !== row.ruleFingerprint
      ) {
        this.#state.clearPending(row.chatId, row.provider, row.eventId)
        continue
      }
      const quiet = quietUntil(subscription.quietHours, this.#clock.now())
      if (quiet !== null) {
        this.#postpone(row, quiet)
        continue
      }
      if (
        this.#failedProviders.has(row.provider) ||
        this.#blockedEvents.has(key(row.chatId, row.provider, row.eventId))
      ) {
        this.#postpone(row, this.#clock.now() + idleSeconds * 1000)
        continue
      }
      const grouped =
        row.dueAt > row.firstSeenAt &&
        Boolean(subscription.quietHours || subscription.batchWindowSeconds)
      if (!grouped) {
        batches.push({ chatId: row.chatId, rows: [row] })
        continue
      }
      let list = groups.get(row.chatId)
      if (!list) {
        list = []
        groups.set(row.chatId, list)
        batches.push({ chatId: row.chatId, rows: list })
      }
      list.push(row)
    }
    for (const { chatId, rows } of batches) {
      let batch: PendingStatusNotification[] = []
      let message = ""
      const send = async () => {
        if (!batch.length) return
        const deliveryAuthorize = () => {
          authorize()
          const subscription = resolveStatusSubscription(settings, chatId)
          const quiet = quietUntil(subscription?.quietHours ?? null, this.#clock.now())
          if (quiet !== null) throw new QuietWindowStarted(quiet)
          for (const row of batch)
            this.#state.recordAttempt(chatId, row.provider, this.#clock.now())
        }
        try {
          await this.#send(chatId, message, signal, deliveryAuthorize)
        } catch (error) {
          if (error instanceof QuietWindowStarted) {
            for (const row of batch) this.#postpone(row, error.until)
            batch = []
            message = ""
            return
          }
          for (const row of batch)
            this.#state.recordDelivery(
              chatId,
              row.provider,
              false,
              this.#clock.now(),
              statusDiagnostic(error),
            )
          authorize()
          for (const row of batch) this.#postpone(row, this.#clock.now() + idleSeconds * 1000)
          this.options.logger.warn(`Could not deliver service status to chat ${chatId}`)
          batch = []
          message = ""
          return
        }
        for (const row of batch)
          this.#state.recordDelivery(chatId, row.provider, true, this.#clock.now())
        authorize()
        for (const row of batch) this.#state.complete(row, this.#clock.now())
        batch = []
        message = ""
      }
      for (const row of rows) {
        const text = formatStatusNotification(
          row.provider,
          row.event,
          row.initial && !row.event.active ? "occurred-resolved" : row.change,
          row.changes,
        )
        const subscription = resolveStatusSubscription(settings, chatId)
        const grouped =
          row.dueAt > row.firstSeenAt &&
          Boolean(subscription?.quietHours || subscription?.batchWindowSeconds)
        if (!grouped) {
          await send()
          batch = [row]
          message = text
          await send()
          continue
        }
        if (message && Array.from(`${message}\n\n${text}`).length >= 1000) await send()
        message = message ? `${message}\n\n${text}` : text
        batch.push(row)
      }
      await send()
    }
  }

  #send(chatId: number, text: string, signal: AbortSignal, authorize: () => void): Promise<void> {
    const work = this.#sendTail.then(async () => {
      signal.throwIfAborted()
      let wait = this.#nextSend - this.#clock.monotonic()
      while (wait > 0) {
        await this.#clock.wait(Math.ceil(wait), signal)
        wait = this.#nextSend - this.#clock.monotonic()
      }
      authorize()
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)])
      try {
        await withStatusSignal(this.options.send(chatId, text, deadline), deadline)
      } finally {
        this.#nextSend = this.#clock.monotonic() + 100
      }
    })
    this.#sendTail = work.catch(() => {})
    return work
  }

  async components(provider: StatusProviderId, signal: AbortSignal) {
    this.#assertOpen()
    try {
      return await this.#catalog.components(provider, signal)
    } catch (error) {
      this.#assertOpen()
      throw error
    }
  }

  deliveries(query: StatusDeliveryQuery): ServiceStatusDeliveryResponse {
    this.#assertOpen()
    return this.#state.results(query, this.#clock.now(), this.#nextPollAt || null)
  }

  test(input: ServiceStatusTestRequest, context: TestContext): Promise<ServiceStatusTestResult> {
    const work = this.#test(input, context)
    this.#tests.add(work)
    void work.finally(() => this.#tests.delete(work)).catch(() => {})
    return work
  }

  async #test(
    input: ServiceStatusTestRequest,
    context: TestContext,
  ): Promise<ServiceStatusTestResult> {
    this.#assertOpen()
    context.authorize()
    const initial = this.#applied()
    if (!initial || initial.revision !== input.revision)
      throw new AdminError(409, "Save and apply current settings before a test notification")
    if (!input.confirm || !initial.policy.statusNotifications.chatIds.includes(input.chatId))
      throw new AdminError(400, "Select a saved destination and confirm the test notification")
    const last = this.#state.lastTestAttempt(input.chatId)
    if (
      this.#testChats.has(input.chatId) ||
      (last !== undefined && this.#clock.now() - last < 60_000)
    )
      throw new AdminError(429, "Wait one minute before testing this destination again")
    this.#testChats.add(input.chatId)
    this.#state.recordAttempt(input.chatId, "test", this.#clock.now())
    this.options.store.audit(
      context.actor,
      "status.test",
      input.revision,
      "started",
      `chat:${input.chatId}`,
    )
    try {
      return await this.#operation(
        initial,
        async (signal, authorize) => {
          const attemptedAt = this.#clock.now()
          try {
            await this.#send(
              input.chatId,
              "Sumire service status test notification. This is a manual delivery test, not a service incident.",
              signal,
              authorize,
            )
          } catch (error) {
            const code = statusDiagnostic(error)
            this.#state.recordDelivery(input.chatId, "test", false, this.#clock.now(), code)
            this.options.store.audit(
              context.actor,
              "status.test",
              input.revision,
              "failed",
              `chat:${input.chatId}`,
            )
            authorize()
            return { chatId: input.chatId, success: false, code, attemptedAt }
          }
          this.#state.recordDelivery(input.chatId, "test", true, this.#clock.now())
          this.options.store.audit(
            context.actor,
            "status.test",
            input.revision,
            "accepted",
            `chat:${input.chatId}`,
          )
          authorize()
          return { chatId: input.chatId, success: true, code: null, attemptedAt }
        },
        context,
      )
    } finally {
      this.#testChats.delete(input.chatId)
    }
  }

  close(): Promise<void> {
    this.#closed ??= (async () => {
      this.#controller.abort()
      this.#sleep?.abort()
      await Promise.allSettled([
        this.#loop,
        this.#active,
        this.#flushing,
        this.#sendTail,
        ...this.#tests,
      ])
      await this.#catalog.settled()
    })()
    return this.#closed
  }
}

export function createStatusNotificationWorker(
  store: AdminStore,
  api: Pick<Api, "sendMessage">,
  logger: Pick<Logger, "warn">,
) {
  return new StatusNotificationWorker({
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
}

export function startStatusNotificationWorker(
  store: AdminStore,
  api: Pick<Api, "sendMessage">,
  logger: Pick<Logger, "warn">,
) {
  const worker = createStatusNotificationWorker(store, api, logger)
  worker.start()
  return worker
}
