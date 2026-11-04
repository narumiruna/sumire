import type { StatusSubscription } from "@narumitw/sumire-policy"
import type { StatusComponent, StatusSummary } from "@narumitw/sumire-status-page"
import { describe, expect, it } from "vitest"
import { eventFingerprint, type StatusEvent, summaryEvent } from "../src/service-status/events.js"
import { scopeStatusEvents } from "../src/service-status/filter.js"

const api: StatusComponent = { id: "api", name: "API", status: "partial_outage" }
const web: StatusComponent = { id: "web", name: "Web", status: "partial_outage" }

function subscription(overrides: Partial<StatusSubscription> = {}): StatusSubscription {
  return {
    chatId: 101,
    providers: ["github"],
    minimumImpact: "minor",
    componentSelections: { github: null, openai: null, claude: null, cloudflare: null },
    quietHours: null,
    batchWindowSeconds: 0,
    notifyUpdates: true,
    notifyResolved: true,
    includeMaintenance: false,
    ...overrides,
  }
}

function selected(ids: string[], overrides: Partial<StatusSubscription> = {}): StatusSubscription {
  return subscription({
    ...overrides,
    componentSelections: { github: ids, openai: null, claude: null, cloudflare: null },
  })
}

function summary(overrides: Partial<StatusSummary> = {}): StatusSummary {
  return {
    provider: "github",
    indicator: "none",
    description: "All systems operational",
    components: [],
    incidents: [],
    maintenances: [],
    ...overrides,
  }
}

function detail(overrides: Partial<StatusEvent> = {}): StatusEvent {
  return {
    id: "incident:api-errors",
    kind: "incident",
    active: true,
    maintenance: false,
    name: "API errors",
    status: "investigating",
    impact: "major",
    url: "https://www.githubstatus.com/incidents/api-errors",
    body: "Increased API errors.",
    components: [api],
    ...overrides,
  }
}

function aggregate(events: readonly StatusEvent[]): StatusEvent | undefined {
  return events.find((event) => event.id === "summary")
}

describe("service status component selection", () => {
  it("does not select a provider through its component choices", () => {
    expect(
      scopeStatusEvents(
        summary({ components: [api] }),
        [detail()],
        selected(["api"], {
          providers: ["openai"],
        }),
      ),
    ).toEqual([])
  })

  it("keeps null as all components and preserves legacy aggregate content and fingerprints", () => {
    const source = summary({
      indicator: "critical",
      description: "Original provider description",
      components: [api, { id: "ok", name: "Healthy service", status: "operational" }],
    })
    const incident = detail({ components: [] })
    const events = scopeStatusEvents(source, [incident], subscription())
    expect(events[0]).toBe(incident)
    expect(events[1]).toEqual(summaryEvent(source, false))
    expect(eventFingerprint(events[1] as StatusEvent)).toBe(
      eventFingerprint(summaryEvent(source, false)),
    )
  })

  it("treats an explicit empty selection as none, including retained events", () => {
    const retained = new Map([["incident:api-errors", [api]]])
    expect(
      scopeStatusEvents(summary({ components: [api] }), [detail()], selected([]), retained),
    ).toEqual([])
  })

  it("returns applicable detail components before the aggregate without filtering low-severity details", () => {
    const source = summary({ components: [{ ...api, status: "major_outage" }, web] })
    const incident = detail({ components: [web, api], impact: "minor" })
    const events = scopeStatusEvents(
      source,
      [incident, detail({ id: "incident:web", components: [web] })],
      selected(["api"], { minimumImpact: "critical" }),
    )
    expect(events.map((event) => event.id)).toEqual(["incident:api-errors", "summary"])
    expect(events[0]?.components).toEqual([api])
    expect(events[1]?.components).toEqual([{ ...api, status: "major_outage" }])
  })

  it("does not infer component IDs or geography from names", () => {
    const component = { id: "other", name: "Taipei API", status: "major_outage" }
    expect(
      scopeStatusEvents(
        summary({ components: [component] }),
        [detail({ components: [component] })],
        selected(["taipei"]),
      ),
    ).toEqual([])
  })

  it("skips unseen incidents without component associations under an explicit selection", () => {
    const events = scopeStatusEvents(
      summary({ components: [api] }),
      [detail({ components: [] })],
      selected(["api"]),
    )
    expect(events.map((event) => event.id)).toEqual(["summary"])
  })

  it("uses catalog parents when incident components omit group metadata", () => {
    const components: StatusComponent[] = [
      { id: "region", name: "Region", status: "operational", isGroup: true },
      { id: "product", name: "Product", status: "operational", isGroup: true, groupId: "region" },
      { ...api, groupId: "product" },
      web,
    ]
    const events = scopeStatusEvents(
      summary({ components }),
      [detail({ components: [api, web] })],
      selected(["region"]),
    )
    expect(events.map((event) => event.id)).toEqual(["incident:api-errors"])
    expect(events[0]?.components).toEqual([{ ...api, groupId: "product" }])
  })

  it("matches newly published descendants without changing stored group IDs", () => {
    const root: StatusComponent = {
      id: "region",
      name: "Region",
      status: "operational",
      isGroup: true,
    }
    const old = { ...api, groupId: "region", status: "operational" }
    const current = summary({ components: [root, old, { ...web, groupId: "region" }] })
    const event = aggregate(scopeStatusEvents(current, [], selected(["region"])))
    expect(event?.active).toBe(true)
    expect(event?.components.map((component) => component.id)).toEqual(["api", "region", "web"])
  })

  it("takes current catalog membership over stale incident or retained membership", () => {
    const current = { ...api, groupId: "new-region" }
    const stale = { ...api, groupId: "old-region" }
    const source = summary({ components: [current] })
    expect(
      scopeStatusEvents(source, [detail({ components: [stale] })], selected(["old-region"])),
    ).toEqual([])
    expect(
      scopeStatusEvents(
        source,
        [detail({ active: false, components: [] })],
        selected(["old-region"]),
        new Map([["incident:api-errors", [stale]]]),
      ),
    ).toEqual([])
  })

  it("does not turn a missing selection or an empty catalog into all components or recovery", () => {
    expect(
      scopeStatusEvents(
        summary({ components: [{ ...web, status: "operational" }] }),
        [],
        selected(["missing"]),
      ),
    ).toEqual([])
    expect(scopeStatusEvents(summary(), [], selected(["api"]))).toEqual([])
    expect(scopeStatusEvents(summary(), [detail()], selected(["api"]))).toEqual([detail()])
  })

  it("keeps a known selected outage when another selected ID is unavailable", () => {
    const rules = selected(["api", "missing"])
    expect(aggregate(scopeStatusEvents(summary({ components: [api] }), [], rules))?.active).toBe(
      true,
    )
    expect(
      scopeStatusEvents(summary({ components: [{ ...api, status: "operational" }] }), [], rules),
    ).toEqual([])
  })

  it("can match published parent IDs without claiming a missing group is healthy", () => {
    const component = { ...api, groupId: "missing-group" }
    expect(
      scopeStatusEvents(
        summary({ components: [component] }),
        [detail()],
        selected(["missing-group"]),
      )[0]?.id,
    ).toBe("incident:api-errors")
    expect(
      scopeStatusEvents(
        summary({ components: [{ ...component, status: "operational" }] }),
        [],
        selected(["missing-group"]),
      ),
    ).toEqual([])
  })

  it.each(["unknown", "new_provider_status", "toString"])(
    "does not treat the selected component status %s as healthy",
    (status) => {
      expect(
        scopeStatusEvents(summary({ components: [{ ...api, status }] }), [], selected(["api"])),
      ).toEqual([])
      expect(
        scopeStatusEvents(summary({ components: [{ ...api, status }] }), [], subscription()),
      ).toEqual([])
    },
  )

  it("keeps unknown matched identities with an active scoped aggregate", () => {
    const components = [api, { ...web, status: "unknown" }]
    expect(
      aggregate(scopeStatusEvents(summary({ components }), [], selected(["api", "web"])))
        ?.components,
    ).toEqual(components)
  })

  it.each([false, true])(
    "ignores under-maintenance status only when maintenance is off (%s)",
    (includeMaintenance) => {
      const components = [{ ...api, status: "under_maintenance" }]
      const event = aggregate(
        scopeStatusEvents(summary({ components }), [], selected(["api"], { includeMaintenance })),
      )
      expect(event).toMatchObject({
        active: includeMaintenance,
        maintenance: includeMaintenance,
        components,
      })
    },
  )

  it("does not use provider-wide impact or description for an explicit selection", () => {
    const components = [
      { ...api, status: "operational" },
      { ...web, status: "major_outage" },
    ]
    const rules = selected(["api"])
    const first = aggregate(
      scopeStatusEvents(
        summary({ components, indicator: "critical", description: "Provider outage" }),
        [],
        rules,
      ),
    )
    const second = aggregate(
      scopeStatusEvents(summary({ components, description: "Provider recovered" }), [], rules),
    )
    expect(first).toMatchObject({
      active: false,
      impact: "none",
      status: "none",
      body: "Status of selected components.",
      name: "GitHub service status (selected components)",
      components: [components[0]],
    })
    expect(first).toEqual(second)
  })

  it("includes selected healthy component identities for aggregate recovery verification", () => {
    const components = [
      { ...web, status: "operational" },
      { ...api, status: "operational" },
    ]
    const event = aggregate(
      scopeStatusEvents(
        summary({ components }),
        [],
        selected(["web", "api"]),
        new Map([["summary", [api, web]]]),
      ),
    )
    expect(event?.active).toBe(false)
    expect(event?.components.map((component) => component.id)).toEqual(["api", "web"])
  })

  it.each([
    {
      reason: "removed by a filter change",
      previous: [web],
      selection: ["api"],
      components: [{ ...api, status: "operational" }],
    },
    {
      reason: "missing from the current group catalog",
      previous: [{ ...api, groupId: "region" }],
      selection: ["region"],
      components: [{ id: "region", name: "Region", status: "operational", isGroup: true }],
    },
    {
      reason: "missing retained association",
      previous: [],
      selection: ["api"],
      components: [{ ...api, status: "operational" }],
    },
  ])(
    "does not invent aggregate recovery for identities $reason",
    ({ previous, selection, components }) => {
      expect(
        scopeStatusEvents(
          summary({ components }),
          [],
          selected(selection),
          new Map([["summary", previous]]),
        ),
      ).toEqual([])
    },
  )

  it("does not mutate catalogs, details, or subscription selections", () => {
    const source = summary({ components: [web, api] })
    const details = [detail({ components: [web, api] })]
    const rules = selected(["web", "api"])
    const before = structuredClone({ source, details, rules })
    scopeStatusEvents(source, details, rules)
    expect({ source, details, rules }).toEqual(before)
  })

  it("returns each event ID once and keeps detail input order before the aggregate", () => {
    const first = detail({ id: "incident:z", impact: "minor" })
    const second = detail({ id: "incident:a", impact: "minor" })
    const events = scopeStatusEvents(
      summary({ components: [api] }),
      [first, second, first],
      subscription({ minimumImpact: "critical" }),
    )
    expect(events.map((event) => event.id)).toEqual(["incident:z", "incident:a", "summary"])
  })
})

describe("service status retained incident associations", () => {
  it.each(["successful checkpoint", "pending entry"])(
    "uses a %s to match a terminal detail that omits its component list",
    () => {
      const terminal = detail({ active: false, status: "resolved", impact: "none", components: [] })
      const retained = new Map([["incident:api-errors", [web, api]]])
      const events = scopeStatusEvents(
        summary(),
        [terminal],
        selected(["api"], { minimumImpact: "critical" }),
        retained,
      )
      expect(events).toEqual([{ ...terminal, components: [api] }])
    },
  )

  it("retains catalog parent metadata when the incident omits it", () => {
    const root: StatusComponent = {
      id: "region",
      name: "Region",
      status: "operational",
      isGroup: true,
    }
    const rules = selected(["region"])
    const observed = scopeStatusEvents(
      summary({ components: [root, { ...api, groupId: "region" }] }),
      [detail()],
      rules,
    )[0]
    if (!observed) throw new Error("Expected a matched incident")
    expect(observed.components).toEqual([{ ...api, groupId: "region" }])
    const terminal = detail({ active: false, components: [] })
    expect(
      scopeStatusEvents(
        summary(),
        [terminal],
        rules,
        new Map([[observed.id, observed.components]]),
      ),
    ).toEqual([{ ...terminal, components: [{ ...api, groupId: "region" }] }])
  })

  it("uses current intermediate parents to match retained nested children", () => {
    const terminal = detail({ active: false, components: [] })
    const retained = new Map([["incident:api-errors", [{ ...api, groupId: "product" }]]])
    const product = {
      id: "product",
      name: "Product",
      status: "operational",
      groupId: "region",
      isGroup: true,
    }
    expect(
      scopeStatusEvents(
        summary({ components: [product] }),
        [terminal],
        selected(["region"]),
        retained,
      ),
    ).toEqual([{ ...terminal, components: [{ ...api, groupId: "product" }] }])
    // An absent intermediate parent is not proof that the old child still belongs to this group.
    expect(scopeStatusEvents(summary(), [terminal], selected(["region"]), retained)).toEqual([])
  })

  it("uses retained group metadata when a terminal child is absent from the current catalog", () => {
    const terminal = detail({ active: false, components: [] })
    const retained = new Map([["incident:api-errors", [{ ...api, groupId: "region" }]]])
    expect(scopeStatusEvents(summary(), [terminal], selected(["region"]), retained)).toEqual([
      { ...terminal, components: [{ ...api, groupId: "region" }] },
    ])
  })

  it("does not infer a terminal association from unrelated catalog entries or another event", () => {
    const terminal = detail({ active: false, components: [] })
    const retained = new Map([["incident:other", [api]]])
    const events = scopeStatusEvents(
      summary({ components: [api] }),
      [terminal],
      selected(["api"]),
      retained,
    )
    expect(events.map((event) => event.id)).toEqual(["summary"])
  })

  it("does not use retained associations after the selection changes", () => {
    const terminal = detail({ active: false, components: [] })
    expect(
      scopeStatusEvents(
        summary(),
        [terminal],
        selected(["web"]),
        new Map([["incident:api-errors", [api]]]),
      ),
    ).toEqual([])
  })

  it("does not replace a present unrelated component list with retained associations", () => {
    const terminal = detail({ active: false, components: [web] })
    expect(
      scopeStatusEvents(
        summary(),
        [terminal],
        selected(["api"]),
        new Map([["incident:api-errors", [api]]]),
      ),
    ).toEqual([])
  })

  it("does not infer an active association from retained metadata when the source omits it", () => {
    expect(
      scopeStatusEvents(
        summary(),
        [detail({ components: [] })],
        selected(["api"]),
        new Map([["incident:api-errors", [api]]]),
      ),
    ).toEqual([])
  })

  it("keeps terminal details below the current threshold for the worker to acknowledge", () => {
    const terminal = detail({ active: false, status: "resolved", impact: "none" })
    expect(
      scopeStatusEvents(summary(), [terminal], selected(["api"], { minimumImpact: "critical" })),
    ).toEqual([terminal])
  })
})

describe("service status aggregate coverage regressions", () => {
  it.each([
    { reason: "below-threshold", impact: "minor", componentId: "api" },
    { reason: "lower-impact", impact: "major", componentId: "api" },
    { reason: "unrelated", impact: "critical", componentId: "other" },
  ] as const)(
    "keeps a critical aggregate alongside a $reason detail",
    ({ impact, componentId }) => {
      const source = summary({
        indicator: "critical",
        components: [{ ...api, status: "major_outage" }],
      })
      const incident = detail({ impact, components: [{ ...api, id: componentId }] })
      for (const rules of [
        subscription({ minimumImpact: "major" }),
        selected(["api"], { minimumImpact: "major" }),
      ]) {
        expect(aggregate(scopeStatusEvents(source, [incident], rules))?.impact).toBe("critical")
      }
    },
  )

  it("checks provider-wide impact independently of degraded component impact", () => {
    expect(
      aggregate(
        scopeStatusEvents(
          summary({ indicator: "critical", components: [api] }),
          [detail()],
          subscription(),
        ),
      )?.impact,
    ).toBe("critical")
  })

  it("suppresses the aggregate only when eligible details together cover all applicable components", () => {
    const source = summary({ indicator: "major", components: [api, web] })
    const details = [detail(), detail({ id: "incident:web", components: [web] })]
    expect(scopeStatusEvents(source, details, subscription({ minimumImpact: "major" }))).toEqual(
      details,
    )
    expect(aggregate(scopeStatusEvents(source, details.slice(0, 1), subscription()))).toBeDefined()
  })

  it.each([
    { impact: "minor", status: "major_outage", suppressed: false },
    { impact: "critical", status: "major_outage", suppressed: true },
    { impact: "minor", status: "degraded_performance", suppressed: true },
  ] as const)(
    "checks component $status coverage by a $impact detail",
    ({ impact, status, suppressed }) => {
      const components = [
        { ...api, status: "major_outage" },
        { ...web, status },
      ]
      const details = [
        detail({ impact: "critical" }),
        detail({ id: "incident:web", impact, components: [web] }),
      ]
      expect(
        Boolean(
          aggregate(
            scopeStatusEvents(
              summary({ indicator: "critical", components }),
              details,
              subscription(),
            ),
          ),
        ),
      ).toBe(!suppressed)
    },
  )

  it("does not let a confirmed terminal detail suppress an active aggregate", () => {
    expect(
      aggregate(
        scopeStatusEvents(
          summary({ components: [api] }),
          [detail({ active: false })],
          subscription(),
        ),
      ),
    ).toBeDefined()
  })

  it("does not let maintenance cover an outage, even on the same component", () => {
    const maintenance = detail({
      id: "maintenance:api",
      kind: "maintenance",
      maintenance: true,
      impact: "maintenance",
    })
    const events = scopeStatusEvents(
      summary({ components: [api] }),
      [maintenance],
      subscription({ includeMaintenance: true }),
    )
    expect(events.map((event) => event.id)).toEqual(["maintenance:api", "summary"])
  })

  it.each(["incident", "maintenance"] as const)(
    "keeps unrelated aggregate maintenance beside a detailed %s",
    (kind) => {
      const incident = detail({
        kind,
        maintenance: kind === "maintenance",
        impact: kind === "maintenance" ? "maintenance" : "critical",
      })
      const source = summary({ components: [{ ...web, status: "under_maintenance" }] })
      expect(
        aggregate(
          scopeStatusEvents(
            source,
            [incident],
            subscription({ includeMaintenance: true, minimumImpact: "critical" }),
          ),
        )?.maintenance,
      ).toBe(true)
    },
  )

  it.each([false, true])("requires maintenance coverage for a mixed aggregate (%s)", (covered) => {
    const components = [
      { ...api, status: "major_outage" },
      { ...web, status: "under_maintenance" },
    ]
    const details = [detail({ impact: "critical", components })]
    if (covered)
      details.push(
        detail({
          id: "maintenance:web",
          kind: "maintenance",
          maintenance: true,
          impact: "maintenance",
          components: [web],
        }),
      )
    expect(
      Boolean(
        aggregate(
          scopeStatusEvents(
            summary({ indicator: "critical", components }),
            details,
            subscription({ includeMaintenance: true }),
          ),
        ),
      ),
    ).toBe(!covered)
  })

  it("omits maintenance details and maintenance-only aggregate degradation when maintenance is off", () => {
    const source = summary({ components: [{ ...api, status: "under_maintenance" }] })
    const maintenance = detail({
      id: "maintenance:api",
      kind: "maintenance",
      maintenance: true,
      impact: "maintenance",
    })
    const events = scopeStatusEvents(source, [maintenance], subscription())
    expect(events).toEqual([summaryEvent(source, false)])
  })
})

describe("service status group traversal bounds", () => {
  it.each([
    [{ ...api, groupId: "api" }],
    [
      { ...api, groupId: "web" },
      { ...web, groupId: "api" },
    ],
  ])("rejects cyclic catalog relationships", (...components) => {
    expect(() => scopeStatusEvents(summary({ components }), [], selected(["api"]))).toThrow(
      "Cyclic",
    )
  })

  it("rejects cyclic metadata outside the current catalog", () => {
    expect(() =>
      scopeStatusEvents(
        summary(),
        [detail({ components: [{ ...api, groupId: "api" }] })],
        selected(["api"]),
      ),
    ).toThrow("Cyclic")
  })

  it("accepts a bounded 2048-node hierarchy without recursive traversal", () => {
    const components = Array.from(
      { length: 2048 },
      (_, index): StatusComponent => ({
        id: `component-${index}`,
        name: `Component ${index}`,
        status: index === 2047 ? "major_outage" : "operational",
        ...(index ? { groupId: `component-${index - 1}` } : { isGroup: true }),
      }),
    )
    const event = aggregate(
      scopeStatusEvents(summary({ components }), [], selected(["component-0"])),
    )
    expect(event?.components).toHaveLength(2048)
    expect(event?.impact).toBe("critical")
    expect(() =>
      scopeStatusEvents(
        summary({ components: [...components, { ...api, id: "overflow" }] }),
        [],
        selected(["component-0"]),
      ),
    ).toThrow("too large")
  })

  it("rejects duplicate catalog identities instead of choosing an arbitrary parent", () => {
    expect(() =>
      scopeStatusEvents(summary({ components: [api, api] }), [], selected(["api"])),
    ).toThrow("Duplicate")
  })
})
