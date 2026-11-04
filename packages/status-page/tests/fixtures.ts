export const timestamp = "2026-01-02T03:04:05.000Z"

export function component(overrides: Record<string, unknown> = {}) {
  return { id: "component_1", name: "API", status: "operational", ...overrides }
}

export function incident(overrides: Record<string, unknown> = {}) {
  return {
    id: "incident_1",
    name: "API errors",
    status: "investigating",
    impact: "minor",
    updated_at: timestamp,
    components: [component()],
    incident_updates: [{ body: "We are investigating.", created_at: timestamp }],
    ...overrides,
  }
}

export function summary(overrides: Record<string, unknown> = {}) {
  return {
    status: { indicator: "minor", description: "Degraded performance" },
    components: [component()],
    incidents: [incident()],
    scheduled_maintenances: [],
    ...overrides,
  }
}

// Small Statuspage fixtures; OpenAI omits both event arrays.
export const statusFixtures = {
  github: summary({
    components: [component({ name: "Git Operations", status: "degraded_performance" })],
    incidents: [incident({ name: "Git Operations errors" })],
  }),
  openai: {
    status: { indicator: "none", description: "All Systems Operational" },
    components: [component({ name: "API" })],
  },
  claude: summary({
    status: { indicator: "major", description: "Partial System Outage" },
    components: [component({ name: "Claude API", status: "partial_outage" })],
    incidents: [incident({ name: "Elevated errors", impact: "major", status: "identified" })],
  }),
  cloudflare: summary({
    components: [component({ name: "CDN", status: "under_maintenance" })],
    incidents: [],
    scheduled_maintenances: [
      incident({
        id: "maintenance_1",
        name: "Network maintenance",
        status: "scheduled",
        impact: "maintenance",
        scheduled_for: "2026-01-03T00:00:00Z",
        scheduled_until: "2026-01-03T02:00:00Z",
      }),
    ],
  }),
}
