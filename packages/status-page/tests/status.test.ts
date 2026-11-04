import { describe, expect, it } from "vitest"
import {
  parseStatusIncident,
  parseStatusSummary,
  type StatusProviderId,
  statusProviders,
} from "../src/index.js"
import { component, incident, statusFixtures, summary, timestamp } from "./fixtures.js"

describe("public status providers", () => {
  it("exposes only the four fixed origins and names", () => {
    expect(statusProviders).toEqual([
      { id: "github", name: "GitHub", url: "https://www.githubstatus.com" },
      { id: "openai", name: "OpenAI", url: "https://status.openai.com" },
      { id: "claude", name: "Claude", url: "https://status.claude.com" },
      { id: "cloudflare", name: "Cloudflare", url: "https://www.cloudflarestatus.com" },
    ])
    expect(Object.isFrozen(statusProviders)).toBe(true)
    expect(statusProviders.every(Object.isFrozen)).toBe(true)
  })

  it.each([
    "GitHub",
    "github\n",
    "",
    "__proto__",
    "https://status.openai.com",
    null,
    {},
    ["github"],
  ])("rejects a noncanonical provider %j in both parsers", (provider) => {
    expect(() => parseStatusSummary(provider as StatusProviderId, statusFixtures.github)).toThrow(
      "Unsupported status provider",
    )
    expect(() => parseStatusIncident(provider as StatusProviderId, incident())).toThrow(
      "Unsupported status provider",
    )
  })
})

describe("summary normalization", () => {
  it.each(statusProviders)("normalizes the $name fixture", ({ id, url }) => {
    const result = parseStatusSummary(id, statusFixtures[id])
    expect(result.provider).toBe(id)
    expect(result.components).toHaveLength(1)
    expect(result.components[0]).toHaveProperty("status")
    for (const event of [...result.incidents, ...result.maintenances]) {
      expect(event.url).toBe(`${url}/incidents/${event.id}`)
      expect(event.updatedAt).toBe(timestamp)
      expect(event.body).toBe("We are investigating.")
      expect(event.components).toEqual([component()])
    }
    if (id === "openai") {
      expect(result).toEqual({
        provider: "openai",
        indicator: "none",
        description: "All Systems Operational",
        components: [component()],
        incidents: [],
        maintenances: [],
      })
    }
    if (id === "cloudflare") {
      expect(result.incidents).toEqual([])
      expect(result.maintenances[0]).toMatchObject({
        status: "scheduled",
        impact: "maintenance",
        scheduledFor: "2026-01-03T00:00:00Z",
        scheduledUntil: "2026-01-03T02:00:00Z",
      })
    }
  })

  it("strips unknown fields without following page URLs or shortlinks", () => {
    const result = parseStatusSummary(
      "github",
      summary({
        page: { url: "https://user:password@127.0.0.1/private" },
        status: { indicator: "none", description: "Operational", secret: "unused" },
        components: [component({ extra: "unused" })],
        incidents: [
          incident({
            shortlink: "file:///etc/passwd",
            page: { url: "http://169.254.169.254/" },
            url: "https://user:password@hostile.invalid/private",
            components: [component({ extra: "unused" })],
            incident_updates: [{ body: "Latest", created_at: timestamp, extra: "unused" }],
            scheduled_for: null,
            scheduled_until: null,
          }),
        ],
      }),
    )
    expect(result).toEqual({
      provider: "github",
      indicator: "none",
      description: "Operational",
      components: [component()],
      incidents: [
        {
          id: "incident_1",
          name: "API errors",
          status: "investigating",
          impact: "minor",
          url: "https://www.githubstatus.com/incidents/incident_1",
          updatedAt: timestamp,
          body: "Latest",
          components: [component()],
        },
      ],
      maintenances: [],
    })
  })

  it("accepts 481 Cloudflare components and hundreds of maintenance events", () => {
    const result = parseStatusSummary(
      "cloudflare",
      summary({
        components: Array.from({ length: 481 }, (_, i) => component({ id: `component_${i}` })),
        incidents: [],
        scheduled_maintenances: Array.from({ length: 600 }, (_, i) =>
          incident({
            id: `maintenance_${i}`,
            status: "in_progress",
            impact: "maintenance",
            components: [],
            incident_updates: [],
          }),
        ),
      }),
    )
    expect(result.components).toHaveLength(481)
    expect(result.maintenances).toHaveLength(600)
    expect(result.maintenances[599]?.id).toBe("maintenance_599")
  })

  it.each(["incidents", "scheduled_maintenances"])(
    "defaults a missing %s array to an empty array",
    (field) => {
      const result = parseStatusSummary("openai", summary({ [field]: undefined }))
      expect(field === "incidents" ? result.incidents : result.maintenances).toEqual([])
    },
  )

  it.each(["none", "minor", "major", "critical"] as const)(
    "preserves indicator %s",
    (indicator) => {
      expect(
        parseStatusSummary("github", summary({ status: { indicator, description: "Status" } }))
          .indicator,
      ).toBe(indicator)
    },
  )
})

describe("incident normalization", () => {
  it.each(statusProviders)(
    "accepts the $name incident envelope and bare incident",
    ({ id, url }) => {
      const event = incident({ id: "AZaz09_-", shortlink: "https://user:password@127.0.0.1/" })
      const bare = parseStatusIncident(id, event)
      expect(parseStatusIncident(id, { incident: event, extra: "unused" })).toEqual(bare)
      expect(bare.url).toBe(`${url}/incidents/AZaz09_-`)
    },
  )

  it("uses timestamps rather than update array order", () => {
    const updates = [
      { body: "Oldest", created_at: "2026-01-01T00:00:00Z" },
      { body: "Latest", updated_at: "2026-01-03T01:00:00+01:00", created_at: timestamp },
      { body: "Middle", display_at: "2026-01-02T12:00:00Z", created_at: timestamp },
    ]
    for (const incident_updates of [
      updates,
      [...updates].reverse(),
      [updates[1], updates[0], updates[2]],
    ]) {
      const result = parseStatusIncident("github", incident({ incident_updates }))
      expect(result.body).toBe("Latest")
      expect(result.updatedAt).toBe(timestamp)
    }
  })

  it("uses updated_at, display_at, and created_at in that priority order", () => {
    expect(
      parseStatusIncident(
        "github",
        incident({
          incident_updates: [
            {
              body: "Updated field wins",
              updated_at: "2026-01-04T00:00:00Z",
              display_at: "2026-01-09T00:00:00Z",
              created_at: "2026-01-10T00:00:00Z",
            },
            {
              body: "Display fallback",
              updated_at: null,
              display_at: "2026-01-05T00:00:00Z",
              created_at: "2026-01-01T00:00:00Z",
            },
            { body: "Created fallback", created_at: "2026-01-03T00:00:00Z" },
          ],
        }),
      ).body,
    ).toBe("Display fallback")
  })

  it("keeps the first update when timestamps are equal or absent", () => {
    for (const incident_updates of [
      [
        { body: "First", updated_at: "2026-01-01T01:00:00+01:00" },
        { body: "Second", display_at: "2026-01-01T00:00:00Z" },
      ],
      [{ body: "First" }, { body: "Second" }],
    ]) {
      expect(parseStatusIncident("claude", incident({ incident_updates })).body).toBe("First")
    }
  })

  it("ranks a timestamped update above an update without timestamps", () => {
    expect(
      parseStatusIncident(
        "claude",
        incident({
          incident_updates: [{ body: "Undated" }, { body: "Dated", created_at: timestamp }],
        }),
      ).body,
    ).toBe("Dated")
  })

  it.each([[], undefined])("allows empty or absent update arrays: %j", (incident_updates) => {
    expect(parseStatusIncident("github", incident({ incident_updates })).body).toBe("")
  })

  it("defaults missing incident components and omits null or absent schedule timestamps", () => {
    const result = parseStatusIncident(
      "github",
      incident({ components: undefined, scheduled_for: null }),
    )
    expect(result.components).toEqual([])
    expect(result).not.toHaveProperty("scheduledFor")
    expect(result).not.toHaveProperty("scheduledUntil")
  })

  it.each([
    "resolved",
    "postmortem",
    "scheduled",
    "in_progress",
    "verifying",
    "completed",
    "new_state",
  ])("preserves status %s without interpretation", (status) => {
    const result = parseStatusSummary(
      "github",
      summary({
        incidents: [incident({ status })],
        scheduled_maintenances: [incident({ status, impact: "maintenance" })],
      }),
    )
    expect(result.incidents[0]?.status).toBe(status)
    expect(result.maintenances[0]?.status).toBe(status)
  })

  it.each(["none", "minor", "major", "critical", "maintenance"])(
    "preserves impact %s",
    (impact) => {
      expect(parseStatusIncident("github", incident({ impact })).impact).toBe(impact)
    },
  )

  it("accepts the exact string and array limits without truncation", () => {
    const result = parseStatusSummary(
      "cloudflare",
      summary({
        status: { indicator: "none", description: "d".repeat(4096) },
        components: Array.from({ length: 2048 }, () =>
          component({ name: "n".repeat(1024), status: "s".repeat(128) }),
        ),
        incidents: Array.from({ length: 1024 }, () =>
          incident({ components: [], incident_updates: [] }),
        ),
        scheduled_maintenances: Array.from({ length: 1024 }, () =>
          incident({ components: [], incident_updates: [] }),
        ),
      }),
    )
    expect(result.components).toHaveLength(2048)
    expect(result.incidents).toHaveLength(1024)
    expect(result.maintenances).toHaveLength(1024)
    const event = parseStatusIncident(
      "github",
      incident({
        id: "a".repeat(128),
        incident_updates: Array.from({ length: 1024 }, (_, i) => ({
          body: i === 0 ? "b".repeat(131072) : "",
          created_at: timestamp,
        })),
      }),
    )
    expect(event.id).toHaveLength(128)
    expect(event.body).toHaveLength(131072)
  })
})

describe("schema rejection", () => {
  it.each([null, undefined, [], "summary", 42, {}])("rejects malformed roots: %j", (input) => {
    expect(() => parseStatusSummary("github", input)).toThrow()
    expect(() => parseStatusIncident("github", input)).toThrow()
  })

  it.each([
    { status: null },
    { status: { indicator: "maintenance", description: "Status" } },
    { status: { indicator: "none", description: "" } },
    { status: { indicator: "none", description: "d".repeat(4097) } },
    { components: undefined },
    { components: null },
    { components: {} },
    { components: [null] },
    { components: [component({ id: "" })] },
    { components: [component({ name: "n".repeat(1025) })] },
    { components: [component({ status: 1 })] },
    { components: [component({ status: "s".repeat(129) })] },
    { components: Array(2049).fill(component()) },
    { incidents: null },
    { incidents: {} },
    { incidents: [null] },
    { incidents: [incident({ impact: "unknown" })] },
    { incidents: Array(1025).fill(incident()) },
    { scheduled_maintenances: null },
    { scheduled_maintenances: "[]" },
    { scheduled_maintenances: [null] },
    { scheduled_maintenances: Array(1025).fill(incident()) },
  ])("rejects malformed summary fields (case %#)", (override) => {
    expect(() => parseStatusSummary("github", summary(override))).toThrow()
  })

  it.each([
    { id: "../private" },
    { id: "ok\n" },
    { id: "a".repeat(129) },
    { name: "" },
    { name: "n".repeat(1025) },
    { status: null },
    { status: "" },
    { status: "s".repeat(129) },
    { impact: "outage" },
    { updated_at: null },
    { updated_at: "not-a-date" },
    { updated_at: "2026-02-30T00:00:00Z" },
    { updated_at: "2026-01-01T00:00:00" },
    { components: null },
    { components: [null] },
    { components: Array(2049).fill(component()) },
    { incident_updates: null },
    { incident_updates: {} },
    { incident_updates: [null] },
    { incident_updates: [{ body: 3, created_at: timestamp }] },
    { incident_updates: [{ created_at: timestamp }] },
    { incident_updates: [{ body: "b".repeat(131073) }] },
    { incident_updates: [{ body: "", updated_at: "bad" }] },
    { incident_updates: [{ body: "", display_at: "bad" }] },
    { incident_updates: [{ body: "", created_at: "bad" }] },
    { incident_updates: Array(1025).fill({ body: "" }) },
    { scheduled_for: "invalid" },
    { scheduled_until: 42 },
  ])("rejects malformed incident fields (case %#)", (override) => {
    expect(() => parseStatusIncident("github", incident(override))).toThrow()
    expect(() => parseStatusIncident("github", { incident: incident(override) })).toThrow()
  })

  it("checks array limits before reading any element", () => {
    const components = Array(2049)
    Object.defineProperty(components, "0", {
      get() {
        throw new Error("Array element must not be read")
      },
    })
    expect(() => parseStatusSummary("github", summary({ components }))).toThrow(
      "Expected a status array with at most 2048 entries",
    )
  })
})
