import { createHash } from "node:crypto"
import {
  type StatusComponent,
  type StatusImpact,
  type StatusIncident,
  type StatusProviderId,
  type StatusSummary,
  statusProviders,
} from "@narumitw/sumire-status-page"

export const impactRank = { none: 0, minor: 1, major: 2, critical: 3 } as const

export interface StatusEvent {
  id: string
  kind: "incident" | "maintenance" | "summary"
  active: boolean
  maintenance: boolean
  name: string
  status: string
  impact: StatusImpact
  url: string
  body: string
  components: StatusComponent[]
  scheduledFor?: string
  scheduledUntil?: string
}

export function incidentEvent(incident: StatusIncident, maintenance = false): StatusEvent {
  maintenance ||= incident.impact === "maintenance"
  return {
    ...incident,
    id: `${maintenance ? "maintenance" : "incident"}:${incident.id}`,
    kind: maintenance ? "maintenance" : "incident",
    active: !["resolved", "postmortem", "completed"].includes(incident.status),
    maintenance,
  }
}

const componentImpacts: Record<string, keyof typeof impactRank> = {
  degraded_performance: "minor",
  partial_outage: "major",
  major_outage: "critical",
}

/** Component status is required because some providers omit incidents from summary responses. */
export function summaryEvent(summary: StatusSummary, includeMaintenance: boolean): StatusEvent {
  const components = summary.components.filter(
    (component) =>
      Object.hasOwn(componentImpacts, component.status) ||
      (includeMaintenance && component.status === "under_maintenance"),
  )
  let impact: keyof typeof impactRank = summary.indicator
  for (const component of components) {
    const next = componentImpacts[component.status] ?? "none"
    if (impactRank[next] > impactRank[impact]) impact = next
  }
  const maintenance = impact === "none" && components.length > 0
  const provider = statusProviders.find((provider) => provider.id === summary.provider)
  if (!provider) throw new Error("Unknown status provider")
  return {
    id: "summary",
    kind: "summary",
    active: impact !== "none" || maintenance,
    maintenance,
    name: `${provider.name} service status`,
    status: maintenance ? "under_maintenance" : impact,
    impact: maintenance ? "maintenance" : impact,
    url: provider.url,
    body: summary.description,
    components,
  }
}

/** Ignore timestamps, array order, and unrelated operational component changes. */
export function eventFingerprint(event: StatusEvent): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        active: event.active,
        maintenance: event.maintenance,
        name: event.name,
        status: event.status,
        impact: event.impact,
        body: event.body,
        scheduledFor: event.scheduledFor,
        scheduledUntil: event.scheduledUntil,
        components: [...event.components]
          .map(({ id, name, status }) => ({ id, name, status }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      }),
    )
    .digest("hex")
}

function bounded(value: string, length: number): string {
  const points = Array.from(value.trim()).filter(
    (point) => point === "\n" || point === "\t" || (point >= " " && point !== "\u007f"),
  )
  return points.length > length ? `${points.slice(0, length - 1).join("")}…` : points.join("")
}

/** Plain text only. No provider text becomes formatting, model input, or authorization. */
export function formatStatusNotification(
  provider: StatusProviderId,
  event: StatusEvent,
  change: "new" | "update" | "resolved",
): string {
  const name = statusProviders.find((entry) => entry.id === provider)?.name ?? provider
  const label = change === "resolved" ? "已恢復" : change === "update" ? "事件更新" : "服務異常"
  const heading = event.maintenance && change !== "resolved" ? "計畫性維護" : label
  const components = event.components.map((component) => `${component.name}: ${component.status}`)
  const schedule = [event.scheduledFor, event.scheduledUntil]
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).toISOString())
  return [
    `[${name}] ${heading}`,
    bounded(event.name, 120),
    `狀態：${bounded(event.status, 40)}｜影響：${event.impact}`,
    schedule.length ? `維護時間：${schedule.join(" → ")}` : "",
    components.length ? `元件：${bounded(components.join(", "), 140)}` : "",
    event.body ? bounded(event.body, 350) : "",
    event.url,
  ]
    .filter(Boolean)
    .join("\n")
}
