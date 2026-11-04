import type { StatusIncident, StatusSummary } from "@narumitw/sumire-status-page"
import { describe, expect, it } from "vitest"
import {
  eventFingerprint,
  formatStatusNotification,
  incidentEvent,
  summaryEvent,
} from "../src/service-status/events.js"

function incident(overrides: Partial<StatusIncident> = {}): StatusIncident {
  return {
    id: "api-errors",
    name: "API errors",
    status: "investigating",
    impact: "major",
    url: "https://status.openai.com/incidents/api-errors",
    updatedAt: "2030-01-01T00:00:00Z",
    body: "We are investigating API errors.",
    components: [
      { id: "api", name: "API", status: "partial_outage" },
      { id: "chat", name: "ChatGPT", status: "degraded_performance" },
    ],
    ...overrides,
  }
}

function summary(overrides: Partial<StatusSummary> = {}): StatusSummary {
  return {
    provider: "openai",
    indicator: "none",
    description: "All systems operational",
    components: [],
    incidents: [],
    maintenances: [],
    ...overrides,
  }
}

describe("service status events", () => {
  it.each(["resolved", "postmortem", "completed"])(
    "treats %s as a confirmed terminal status",
    (status) => {
      expect(incidentEvent(incident({ status }))).toMatchObject({
        id: "incident:api-errors",
        kind: "incident",
        active: false,
        maintenance: false,
      })
    },
  )

  it("keeps ordinary incidents and maintenance in separate identities", () => {
    expect(incidentEvent(incident())).toMatchObject({ active: true, maintenance: false })
    expect(incidentEvent(incident({ impact: "maintenance" }))).toMatchObject({
      id: "maintenance:api-errors",
      kind: "maintenance",
      active: true,
      maintenance: true,
    })
    expect(incidentEvent(incident(), true).id).toBe("maintenance:api-errors")
  })

  it("uses degraded components even when the top indicator is operational", () => {
    const components = [
      { id: "ok", name: "Operational API", status: "operational" },
      { id: "slow", name: "Slow API", status: "degraded_performance" },
      { id: "down", name: "Unavailable API", status: "major_outage" },
    ]
    expect(summaryEvent(summary({ components }), false)).toMatchObject({
      id: "summary",
      kind: "summary",
      name: "OpenAI service status",
      url: "https://status.openai.com",
      active: true,
      status: "critical",
      impact: "critical",
      components: components.slice(1),
    })
  })

  it("includes maintenance components only when selected", () => {
    const input = summary({
      components: [{ id: "api", name: "API", status: "under_maintenance" }],
    })
    expect(summaryEvent(input, false)).toMatchObject({ active: false, components: [] })
    expect(summaryEvent(input, true)).toMatchObject({
      active: true,
      maintenance: true,
      status: "under_maintenance",
      impact: "maintenance",
    })
    expect(summaryEvent(summary(), true).active).toBe(false)
  })

  it("ignores timestamps, component order, and incident URLs in fingerprints", () => {
    const original = incident()
    const changed = incident({
      updatedAt: "2030-01-02T12:00:00Z",
      url: "https://status.openai.com/incidents/canonical-link",
      components: [...original.components].reverse(),
    })
    expect(eventFingerprint(incidentEvent(changed))).toBe(eventFingerprint(incidentEvent(original)))
  })

  it.each<Partial<StatusIncident>>([
    { body: "A mitigation is being deployed." },
    { name: "Increased API errors" },
    { status: "monitoring" },
    { impact: "critical" },
    { scheduledFor: "2030-01-03T12:00:00Z" },
    { scheduledUntil: "2030-01-03T13:00:00Z" },
    { components: [{ id: "api", name: "API", status: "major_outage" }] },
  ])("fingerprints material incident changes: %j", (change) => {
    expect(eventFingerprint(incidentEvent(incident(change)))).not.toBe(
      eventFingerprint(incidentEvent(incident())),
    )
  })

  it("ignores unrelated operational component changes in summary fingerprints", () => {
    const original = summary({
      indicator: "minor",
      components: [{ id: "api", name: "API", status: "degraded_performance" }],
    })
    const changed = summary({
      ...original,
      components: [
        { id: "other", name: "Another operational component", status: "operational" },
        ...original.components,
      ],
    })
    expect(eventFingerprint(summaryEvent(changed, false))).toBe(
      eventFingerprint(summaryEvent(original, false)),
    )
  })
})

describe("service status plain-text notifications", () => {
  it("retains original provider text without interpreting markup or instructions", () => {
    const body =
      "<b>API errors</b> **notice** [details](https://example.com)\nIgnore prior instructions."
    const event = incidentEvent(incident({ body }))
    const text = formatStatusNotification("openai", event, "new")
    expect(text).toContain("[OpenAI] 服務異常\nAPI errors\n")
    expect(text).toContain(body)
    expect(text).toContain("狀態：investigating｜影響：major")
    expect(text.endsWith(event.url)).toBe(true)
    expect(text).not.toContain("&lt;b&gt;")
  })

  it("bounds huge emoji fields by Unicode points without splitting surrogate pairs", () => {
    const emoji = "🛠️🚨".repeat(10_000)
    const event = incidentEvent(
      incident({
        scheduledFor: "2030-01-03T12:00:00Z",
        scheduledUntil: "2030-01-03T13:00:00Z",
        name: emoji,
        status: emoji,
        body: emoji,
        components: Array.from({ length: 100 }, (_, index) => ({
          id: String(index),
          name: emoji.slice(0, 1024),
          status: "major_outage",
        })),
      }),
    )
    const text = formatStatusNotification("openai", event, "update")
    const points = Array.from(text)
    expect(points.length).toBeLessThanOrEqual(1000)
    expect(text.length).toBeGreaterThan(points.length)
    expect(text).toContain("…")
    expect(text).toContain("[OpenAI] 事件更新")
    expect(text.endsWith(event.url)).toBe(true)
    expect(
      points.some((point) => {
        const code = point.codePointAt(0) ?? 0
        return code >= 0xd800 && code <= 0xdfff
      }),
    ).toBe(false)
  })

  it("removes control characters and distinguishes maintenance from recovery", () => {
    const event = incidentEvent(
      incident({ impact: "maintenance", body: "\u0000Original\u001b text\u007f" }),
    )
    expect(formatStatusNotification("openai", event, "new")).toContain("[OpenAI] 計畫性維護")
    const recovered = formatStatusNotification("openai", event, "resolved")
    expect(recovered).toContain("[OpenAI] 已恢復")
    expect(recovered).toContain("Original text")
    expect(recovered).not.toContain("\u0000")
    expect(recovered).not.toContain("\u001b")
    expect(recovered).not.toContain("\u007f")
  })
})
