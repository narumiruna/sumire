import { z } from "zod"

export const statusProviders = Object.freeze([
  Object.freeze({ id: "github", name: "GitHub", url: "https://www.githubstatus.com" } as const),
  Object.freeze({ id: "openai", name: "OpenAI", url: "https://status.openai.com" } as const),
  Object.freeze({ id: "claude", name: "Claude", url: "https://status.claude.com" } as const),
  Object.freeze({
    id: "cloudflare",
    name: "Cloudflare",
    url: "https://www.cloudflarestatus.com",
  } as const),
] as const)

export type StatusProviderId = (typeof statusProviders)[number]["id"]
export type StatusImpact = "none" | "minor" | "major" | "critical" | "maintenance"

export interface StatusComponent {
  id: string
  name: string
  status: string
  groupId?: string | null
  isGroup?: boolean
}

export interface StatusIncident {
  id: string
  name: string
  status: string
  impact: StatusImpact
  url: string
  updatedAt: string
  body: string
  components: StatusComponent[]
  scheduledFor?: string
  scheduledUntil?: string
}

export interface StatusSummary {
  provider: StatusProviderId
  indicator: "none" | "minor" | "major" | "critical"
  description: string
  components: StatusComponent[]
  incidents: StatusIncident[]
  maintenances: StatusIncident[]
}

export function getStatusProvider(provider: StatusProviderId) {
  const entry = statusProviders.find((entry) => entry.id === provider)
  if (!entry) throw new Error("Unsupported status provider")
  return entry
}

// Unlike $, the final assertion also rejects a trailing newline.
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}(?![\s\S])/)
const timestampSchema = z.iso.datetime({ offset: true }).max(64)
const stateSchema = z.string().min(1).max(128)

// Check array length before traversing entries, including for direct parser calls.
function boundedArray<T extends z.ZodType>(schema: T, limit: number) {
  return z
    .custom<unknown[]>(
      (input) => Array.isArray(input) && input.length <= limit,
      `Expected a status array with at most ${limit} entries`,
    )
    .pipe(z.array(schema))
}

const componentSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(1024),
    status: stateSchema,
    group_id: idSchema.nullable().optional(),
    group: z.boolean().optional(),
  })
  .transform(({ id, name, status, group_id, group }) => ({
    id,
    name,
    status,
    ...(group_id === undefined ? {} : { groupId: group_id }),
    ...(group === undefined ? {} : { isGroup: group }),
  }))

function validateComponentHierarchy(components: StatusComponent[], context: z.RefinementCtx) {
  const byId = new Map<string, { component: StatusComponent; index: number }>()
  for (const [index, component] of components.entries()) {
    if (byId.has(component.id))
      context.addIssue({ code: "custom", path: [index, "id"], message: "Duplicate component ID" })
    else byId.set(component.id, { component, index })
  }
  for (const { component, index } of byId.values()) {
    const parent = component.groupId ? byId.get(component.groupId)?.component : undefined
    // Missing parents and missing group markers are valid in partial provider data.
    if (parent?.isGroup === false)
      context.addIssue({
        code: "custom",
        path: [index, "group_id"],
        message: "Component parent is explicitly not a group",
      })
  }
  const checked = new Set<string>()
  for (const { component, index } of byId.values()) {
    const path = new Set<string>()
    let current: StatusComponent | undefined = component
    // Iteration bounds traversal to the catalog size without recursive stack growth.
    while (current && !checked.has(current.id)) {
      if (path.has(current.id)) {
        context.addIssue({
          code: "custom",
          path: [index, "group_id"],
          message: "Component hierarchy contains a cycle",
        })
        break
      }
      path.add(current.id)
      current = current.groupId ? byId.get(current.groupId)?.component : undefined
    }
    for (const id of path) checked.add(id)
  }
}

const componentsSchema = boundedArray(componentSchema, 2048).superRefine(validateComponentHierarchy)
const updateSchema = z.object({
  body: z.string().max(128 * 1024),
  updated_at: timestampSchema.nullish(),
  display_at: timestampSchema.nullish(),
  created_at: timestampSchema.nullish(),
})
const incidentSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(1024),
  status: stateSchema,
  impact: z.enum(["none", "minor", "major", "critical", "maintenance"]),
  updated_at: timestampSchema,
  components: componentsSchema.default([]),
  incident_updates: boundedArray(updateSchema, 1024).default([]),
  scheduled_for: timestampSchema.nullish(),
  scheduled_until: timestampSchema.nullish(),
})
const incidentInputSchema = z.union([z.object({ incident: incidentSchema }), incidentSchema])
const summarySchema = z.object({
  status: z.object({
    indicator: z.enum(["none", "minor", "major", "critical"]),
    description: z.string().min(1).max(4096),
  }),
  components: componentsSchema,
  incidents: boundedArray(incidentSchema, 1024).default([]),
  scheduled_maintenances: boundedArray(incidentSchema, 1024).default([]),
})

export function validateIncidentId(incidentId: string): string {
  return idSchema.parse(incidentId)
}

function normalizeIncident(
  provider: ReturnType<typeof getStatusProvider>,
  incident: z.infer<typeof incidentSchema>,
): StatusIncident {
  let latest: z.infer<typeof updateSchema> | undefined
  let latestTime = Number.NEGATIVE_INFINITY
  for (const update of incident.incident_updates) {
    const timestamp = update.updated_at ?? update.display_at ?? update.created_at
    const time = timestamp ? Date.parse(timestamp) : Number.NEGATIVE_INFINITY
    // Equal or absent timestamps keep the first update in source order.
    if (!latest || time > latestTime) {
      latest = update
      latestTime = time
    }
  }
  return {
    id: incident.id,
    name: incident.name,
    status: incident.status,
    impact: incident.impact,
    url: `${provider.url}/incidents/${encodeURIComponent(incident.id)}`,
    updatedAt: incident.updated_at,
    body: latest?.body ?? "",
    components: incident.components,
    ...(incident.scheduled_for != null ? { scheduledFor: incident.scheduled_for } : {}),
    ...(incident.scheduled_until != null ? { scheduledUntil: incident.scheduled_until } : {}),
  }
}

export function parseStatusSummary(provider: StatusProviderId, input: unknown): StatusSummary {
  const entry = getStatusProvider(provider)
  const summary = summarySchema.parse(input)
  return {
    provider: entry.id,
    indicator: summary.status.indicator,
    description: summary.status.description,
    components: summary.components,
    incidents: summary.incidents.map((incident) => normalizeIncident(entry, incident)),
    maintenances: summary.scheduled_maintenances.map((incident) =>
      normalizeIncident(entry, incident),
    ),
  }
}

/** Accept an incident object or the incident API's { incident } envelope. */
export function parseStatusIncident(provider: StatusProviderId, input: unknown): StatusIncident {
  const entry = getStatusProvider(provider)
  const inputIncident = incidentInputSchema.parse(input)
  return normalizeIncident(
    entry,
    "incident" in inputIncident ? inputIncident.incident : inputIncident,
  )
}
