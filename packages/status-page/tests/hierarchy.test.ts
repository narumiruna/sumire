import { describe, expect, it, vi } from "vitest"
import {
  parseStatusIncident,
  parseStatusSummary,
  readStatusSummary,
  statusProviders,
} from "../src/index.js"
import { component, incident, publicComponentFixtures, summary } from "./fixtures.js"

describe("provider component metadata", () => {
  it.each(statusProviders)("preserves the public $name metadata shape", async ({ id }) => {
    const components = publicComponentFixtures[id]
    const fixture = summary({
      components,
      incidents: [incident({ components })],
      scheduled_maintenances: [incident({ components, impact: "maintenance" })],
    })
    const expected = components.map((raw) => ({
      id: raw.id,
      name: raw.name,
      status: raw.status,
      ...("group_id" in raw ? { groupId: raw.group_id } : {}),
      ...("group" in raw ? { isGroup: raw.group } : {}),
    }))
    const result = parseStatusSummary(id, fixture)
    expect(result.components).toEqual(expected)
    expect(result.incidents[0]?.components).toEqual(expected)
    expect(result.maintenances[0]?.components).toEqual(expected)
    expect(parseStatusIncident(id, { incident: incident({ components }) }).components).toEqual(
      expected,
    )
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(fixture))
    expect((await readStatusSummary(id, { fetch: fetcher })).components).toEqual(expected)
  })

  it("keeps absent metadata absent, including existing flat fixtures", () => {
    const result = parseStatusSummary("openai", summary())
    expect(result.components).toEqual([component()])
    expect(result.components[0]).not.toHaveProperty("groupId")
    expect(result.components[0]).not.toHaveProperty("isGroup")
    expect(result.incidents[0]?.components[0]).not.toHaveProperty("groupId")
    expect(result.incidents[0]?.components[0]).not.toHaveProperty("isGroup")
  })

  it("allows missing parent records and missing parent group markers", () => {
    const child = component({ id: "child", group_id: "unavailable-parent", group: false })
    expect(parseStatusSummary("cloudflare", summary({ components: [child] })).components).toEqual([
      {
        id: "child",
        name: "API",
        status: "operational",
        groupId: "unavailable-parent",
        isGroup: false,
      },
    ])
    expect(
      parseStatusIncident("cloudflare", incident({ components: [child] })).components[0]?.groupId,
    ).toBe("unavailable-parent")
    expect(() =>
      parseStatusSummary(
        "cloudflare",
        summary({
          components: [
            component({ id: "child", group_id: "parent", group: false }),
            component({ id: "parent" }),
          ],
        }),
      ),
    ).not.toThrow()
  })

  it("does not infer hierarchy from component names or unknown fields", () => {
    const result = parseStatusSummary(
      "openai",
      summary({
        components: [
          component({ id: "region", name: "Europe", components: ["api"] }),
          component({ id: "api", name: "API - Europe", parent: "region" }),
        ],
      }),
    )
    expect(result.components).toEqual([
      { id: "region", name: "Europe", status: "operational" },
      { id: "api", name: "API - Europe", status: "operational" },
    ])
  })
})

describe("component hierarchy validation", () => {
  it.each([
    [component(), component()],
    [component({ group_id: "component_1", group: true })],
    [
      component({ id: "a", group_id: "b", group: true }),
      component({ id: "b", group_id: "a", group: true }),
    ],
    [
      component({ id: "a", group_id: "b", group: true }),
      component({ id: "b", group_id: "c", group: true }),
      component({ id: "c", group_id: "a", group: true }),
    ],
    [component({ id: "parent", group: false }), component({ id: "child", group_id: "parent" })],
  ])("rejects duplicate IDs, cycles, and explicit non-group parents (case %#)", (...components) => {
    expect(() => parseStatusSummary("cloudflare", summary({ components }))).toThrow()
    expect(() => parseStatusIncident("cloudflare", incident({ components }))).toThrow()
  })

  it("accepts a maximum-depth catalog without recursion and rejects a cycle at that bound", () => {
    const components = Array.from({ length: 2048 }, (_, index) =>
      component({
        id: `node_${index}`,
        group: true,
        group_id: index === 2047 ? null : `node_${index + 1}`,
      }),
    )
    expect(parseStatusSummary("cloudflare", summary({ components })).components).toHaveLength(2048)
    components[2047] = component({ id: "node_2047", group: true, group_id: "node_0" })
    expect(() => parseStatusSummary("cloudflare", summary({ components }))).toThrow("cycle")
  })

  it.each([
    { group_id: "" },
    { group_id: "../parent" },
    { group_id: "parent\n" },
    { group_id: "parent\r\n" },
    { group_id: "parent\u2028" },
    { group_id: "parent\u0000" },
    { group_id: "界" },
    { group_id: "a".repeat(129) },
    { group_id: 1 },
    { group_id: {} },
    { group: null },
    { group: "true" },
    { group: 1 },
  ])("rejects malformed metadata in summaries and incident components: %j", (metadata) => {
    const components = [component(metadata)]
    expect(() => parseStatusSummary("github", summary({ components }))).toThrow()
    expect(() => parseStatusIncident("github", incident({ components }))).toThrow()
    expect(() => parseStatusIncident("github", { incident: incident({ components }) })).toThrow()
  })

  it("accepts strict public parent IDs at both length bounds", () => {
    for (const group_id of ["a", "AZaz09_-", "a".repeat(128)])
      expect(
        parseStatusSummary("cloudflare", summary({ components: [component({ group_id })] }))
          .components[0]?.groupId,
      ).toBe(group_id)
  })
})
