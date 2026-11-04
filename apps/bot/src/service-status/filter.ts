import type { StatusSubscription } from "@narumitw/sumire-policy"
import type { StatusComponent, StatusSummary } from "@narumitw/sumire-status-page"
import { componentImpacts, impactRank, type StatusEvent, summaryEvent } from "./events.js"

const maxComponents = 2048

function componentSelection(components: readonly StatusComponent[], selection: readonly string[]) {
  if (components.length > maxComponents) throw new Error("Status component catalog is too large")
  const catalog = new Map<string, StatusComponent>()
  for (const component of components) {
    if (catalog.has(component.id)) throw new Error("Duplicate status component identity")
    catalog.set(component.id, component)
  }
  const selected = new Set(selection)
  const matched = new Map<string, boolean>()
  for (const component of components) {
    const path: StatusComponent[] = []
    const visited = new Set<string>()
    let current: StatusComponent | undefined = component
    while (current && !matched.has(current.id)) {
      if (visited.has(current.id)) throw new Error("Cyclic status component groups")
      visited.add(current.id)
      path.push(current)
      current = current.groupId ? catalog.get(current.groupId) : undefined
    }
    const last = path.at(-1)
    let match = current
      ? (matched.get(current.id) ?? false)
      : Boolean(last?.groupId && selected.has(last.groupId))
    for (const entry of path.reverse()) {
      match ||= selected.has(entry.id)
      matched.set(entry.id, match)
    }
  }

  function matches(component: StatusComponent): boolean {
    // The current catalog takes precedence over stale incident or retained parent metadata.
    if (catalog.has(component.id)) return matched.get(component.id) ?? false
    const visited = new Set<string>()
    let current: StatusComponent | undefined = component
    let match = false
    while (current) {
      if (visited.has(current.id)) throw new Error("Cyclic status component groups")
      if (visited.size >= maxComponents) throw new Error("Status component ancestry is too large")
      visited.add(current.id)
      match ||= selected.has(current.id)
      if (current.groupId) {
        if (visited.has(current.groupId)) throw new Error("Cyclic status component groups")
        match ||= selected.has(current.groupId)
      }
      current = current.groupId ? catalog.get(current.groupId) : undefined
    }
    return match
  }

  function withCatalogGroups(component: StatusComponent): StatusComponent {
    const current = catalog.get(component.id)
    if (!current) return component
    // Keep source content, but retain the current published parent association for later terminals.
    return {
      id: component.id,
      name: component.name,
      status: component.status,
      ...(current.groupId === undefined ? {} : { groupId: current.groupId }),
      ...(current.isGroup === undefined ? {} : { isGroup: current.isGroup }),
    }
  }

  return {
    matches,
    withCatalogGroups,
    components: components.filter(matches).sort((a, b) => a.id.localeCompare(b.id)),
    complete: selection.every((id) => catalog.has(id)),
  }
}

function healthy(component: StatusComponent, includeMaintenance: boolean): boolean {
  return (
    component.status === "operational" ||
    (!includeMaintenance && component.status === "under_maintenance")
  )
}

function outageRank(event: StatusEvent): number {
  return event.impact === "maintenance" ? 0 : impactRank[event.impact]
}

/** Only eligible active details can replace an aggregate alert of the same kind and impact. */
function covered(
  aggregate: StatusEvent,
  details: readonly StatusEvent[],
  subscription: StatusSubscription,
): boolean {
  const eligible = details.filter(
    (event) =>
      event.active &&
      (event.maintenance
        ? subscription.includeMaintenance
        : outageRank(event) >= impactRank[subscription.minimumImpact]),
  )
  if (
    !eligible.some(
      (event) =>
        event.maintenance === aggregate.maintenance &&
        (aggregate.maintenance || outageRank(event) >= outageRank(aggregate)),
    )
  )
    return false
  const impacts = new Map<string, number>()
  const maintenance = new Set<string>()
  for (const event of eligible) {
    for (const component of event.components) {
      if (event.maintenance) maintenance.add(component.id)
      else impacts.set(component.id, Math.max(impacts.get(component.id) ?? -1, outageRank(event)))
    }
  }
  return aggregate.components.every((component) => {
    if (component.status === "under_maintenance")
      return !subscription.includeMaintenance || maintenance.has(component.id)
    if (!Object.hasOwn(componentImpacts, component.status)) return true
    return (
      (impacts.get(component.id) ?? -1) >= impactRank[componentImpacts[component.status] ?? "none"]
    )
  })
}

/** Scope associations first. The worker owns delivery thresholds and recovery acknowledgement. */
export function scopeStatusEvents(
  summary: StatusSummary,
  details: readonly StatusEvent[],
  subscription: StatusSubscription,
  retained: ReadonlyMap<string, readonly StatusComponent[]> = new Map(),
): StatusEvent[] {
  if (!subscription.providers.includes(summary.provider)) return []
  const selection = subscription.componentSelections[summary.provider]
  if (selection !== null && selection.length === 0) return []
  const scope = selection === null ? null : componentSelection(summary.components, selection)
  const events: StatusEvent[] = []
  const seen = new Set<string>()
  for (const detail of details) {
    if (
      detail.kind === "summary" ||
      seen.has(detail.id) ||
      (detail.maintenance && !subscription.includeMaintenance)
    )
      continue
    if (scope) {
      const associated =
        !detail.active && detail.components.length === 0
          ? (retained.get(detail.id) ?? [])
          : detail.components
      const components = associated.filter(scope.matches).map(scope.withCatalogGroups)
      if (!components.length) continue
      events.push({ ...detail, components })
    } else events.push(detail)
    seen.add(detail.id)
  }

  let aggregate: StatusEvent
  if (scope) {
    aggregate = summaryEvent(
      {
        ...summary,
        indicator: "none",
        description: "Status of selected components.",
        components: scope.components,
      },
      subscription.includeMaintenance,
    )
    aggregate = {
      ...aggregate,
      name: `${aggregate.name} (selected components)`,
      components: scope.components,
    }
    if (!aggregate.active) {
      if (
        !scope.complete ||
        !scope.components.length ||
        !scope.components.every((component) => healthy(component, subscription.includeMaintenance))
      )
        return events
      const previous = retained.get("summary")
      const currentIds = new Set(scope.components.map((component) => component.id))
      if (
        previous &&
        (!previous.length ||
          previous.some((component) => !scope.matches(component) || !currentIds.has(component.id)))
      )
        return events
    }
  } else {
    // Preserve legacy provider-wide content and fingerprints when all components are selected.
    aggregate = summaryEvent(summary, subscription.includeMaintenance)
    if (
      !aggregate.active &&
      !summary.components.every((component) => healthy(component, subscription.includeMaintenance))
    )
      return events
  }
  if (!aggregate.active || !covered(aggregate, events, subscription)) events.push(aggregate)
  return events
}
