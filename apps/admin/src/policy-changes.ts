import {
  type StatusChatOverride,
  type StatusNotifications,
  statusProviderIds,
} from "@narumitw/sumire-policy"
import type { Policy, ProviderSettings, Selection } from "./api.js"
import type { EditorTarget } from "./navigation.js"
import { statusProviderNames } from "./status-notifications.js"

export type PolicyChange = { label: string; targets: EditorTarget[] }

/** Stage one explicit approval without changing chat overrides or other access scopes. */
export function withChatAccess(policy: Policy, id: number, allowed: boolean): Policy {
  if (!Number.isSafeInteger(id) || id === 0) throw new Error("Enter a valid, non-zero Telegram ID")
  const key = id > 0 ? "privateUsers" : "groups"
  return {
    ...policy,
    [key]: allowed
      ? [...new Set([...policy[key], id])]
      : policy[key].filter((value) => value !== id),
  }
}

const different = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b)
const differentSelection = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b)
    ? a.some((value) => !b.includes(value)) || b.some((value) => !a.includes(value))
    : different(a, b)

const selectionFields = [
  ["tools", "Authorized tools"],
  ["skills", "Enabled skills"],
  ["servers", "Authorized MCP servers"],
  ["models", "Allowed models"],
  ["model", "Model"],
  ["thinking", "Thinking level"],
] as const

const statusFields = [
  ["enabled", "notifications", "#status-notifications-enabled"],
  ["pollIntervalSeconds", "polling interval", "#status-polling-interval"],
  ["minimumImpact", "minimum impact", "#status-minimum-impact"],
  ["notifyUpdates", "incident updates", "#status-notification-filters"],
  ["notifyResolved", "resolved incidents", "#status-notification-filters"],
  ["includeMaintenance", "scheduled maintenance", "#status-notification-filters"],
] as const

function statusFilterChanges(saved: StatusNotifications, draft: StatusNotifications) {
  const entries: PolicyChange[] = []
  let count = 0
  const componentLabel = (value: string[] | null | undefined) =>
    value === undefined
      ? "inherit shared selection"
      : value === null
        ? "all components"
        : value.length
          ? `${value.length} selected component/group IDs`
          : "no components (explicit empty selection)"
  const selectionCount = (
    before: string[] | null | undefined,
    after: string[] | null | undefined,
  ) => {
    if (!differentSelection(before, after)) return 0
    if (!Array.isArray(before) || !Array.isArray(after)) return 1
    return (
      before.filter((id) => !after.includes(id)).length +
      after.filter((id) => !before.includes(id)).length
    )
  }
  const quietLabel = (value: StatusNotifications["quietHours"] | undefined) =>
    value === undefined
      ? "inherit shared quiet hours"
      : value === null
        ? "off"
        : `${value.start}–${value.end} (${value.timeZone})`
  const add = (
    scope: string,
    field: string,
    before: string,
    after: string,
    selector: string,
    edits = 1,
  ) => {
    count += edits
    entries.push({
      label: `Service status: ${scope}${field} ${before} → ${after} — notification-only; does not grant Pi access.`,
      targets: [{ page: "Service status", selector }],
    })
  }
  const compare = (
    before: StatusChatOverride,
    after: StatusChatOverride,
    scope: string,
    selector?: string,
  ) => {
    for (const provider of statusProviderIds) {
      const old = before.componentSelections?.[provider]
      const next = after.componentSelections?.[provider]
      // An absent shared selection is all components; only per-chat omissions inherit.
      const a = selector ? old : (old ?? null)
      const b = selector ? next : (next ?? null)
      if (differentSelection(a, b))
        add(
          scope,
          `${statusProviderNames[provider]} components`,
          componentLabel(a),
          componentLabel(b),
          selector ?? "#status-default-components",
          selectionCount(a, b),
        )
    }
    if (different(before.quietHours, after.quietHours))
      add(
        scope,
        "quiet hours",
        quietLabel(before.quietHours),
        quietLabel(after.quietHours),
        selector ?? "#status-default-timing",
      )
    if (before.batchWindowSeconds !== after.batchWindowSeconds) {
      const label = (value: number | undefined) =>
        value === undefined ? "inherit shared grouping" : value === 0 ? "off" : `${value} seconds`
      add(
        scope,
        "update grouping",
        label(before.batchWindowSeconds),
        label(after.batchWindowSeconds),
        selector ?? "#status-default-batch-window",
      )
    }
  }
  compare(saved, draft, "shared defaults: ")
  for (const id of new Set([
    ...Object.keys(saved.chatOverrides),
    ...Object.keys(draft.chatOverrides),
  ])) {
    const before = saved.chatOverrides[id] ?? {}
    const after = draft.chatOverrides[id] ?? {}
    const target = draft.chatIds.includes(Number(id))
      ? `#status-chat-${id}`
      : "#status-notification-destinations"
    const scope = `chat ${id}: `
    if (differentSelection(before.providers, after.providers)) {
      const label = (value: StatusChatOverride["providers"]) =>
        value === undefined
          ? "inherit shared services"
          : value.length
            ? value.map((id) => statusProviderNames[id]).join(", ")
            : "no services (explicit empty override)"
      add(
        scope,
        "services",
        label(before.providers),
        label(after.providers),
        target,
        selectionCount(before.providers, after.providers),
      )
    }
    if (before.minimumImpact !== after.minimumImpact)
      add(
        scope,
        "minimum impact",
        before.minimumImpact ?? "inherit shared impact",
        after.minimumImpact ?? "inherit shared impact",
        target,
      )
    compare(before, after, scope, target)
  }
  return { entries, count }
}

function selectionChanges(
  saved: Selection | undefined,
  draft: Selection | undefined,
  chat: boolean,
): string[] {
  return selectionFields.flatMap(([key, label]) => {
    if (!differentSelection(saved?.[key] ?? null, draft?.[key] ?? null)) return []
    const value = draft?.[key]
    const source =
      value == null
        ? chat
          ? "inherit shared defaults"
          : "no shared default"
        : Array.isArray(value) && value.length === 0
          ? chat
            ? "explicit empty override"
            : "explicit empty selection"
          : chat
            ? "explicit override"
            : "explicit selection"
    return [`${label} (${source})`]
  })
}

function providerChanges(saved: ProviderSettings[], draft: ProviderSettings[]): string[] {
  const fields = new Set<string>()
  for (const id of new Set([...saved, ...draft].map((provider) => provider.id))) {
    const before = saved.find((provider) => provider.id === id)
    const after = draft.find((provider) => provider.id === id)
    if (!before) fields.add("Added provider settings")
    if (!after) fields.add("Removed provider settings")
    for (const [key, label] of [
      ["enabled", "Enabled switch"],
      ["baseUrl", "Endpoint URL"],
      ["api", "API protocol"],
    ] as const)
      if (different(before?.[key], after?.[key])) fields.add(label)
    if (different(before?.models, after?.models)) {
      const models = new Set([...(before?.models ?? []), ...(after?.models ?? [])].map((m) => m.id))
      const changed = [
        ["id", "Model ID"],
        ["name", "Display name"],
        ["reasoning", "Reasoning support"],
        ["image", "Image support"],
        ["contextWindow", "Context window"],
        ["maxTokens", "Maximum output tokens"],
      ] as const
      const labels = changed
        .filter(([key]) =>
          [...models].some((model) =>
            different(
              before?.models.find((m) => m.id === model)?.[key],
              after?.models.find((m) => m.id === model)?.[key],
            ),
          ),
        )
        .map(([, label]) => label)
      if (
        labels.length ||
        different(
          before?.models.map((model) => model.id),
          after?.models.map((model) => model.id),
        )
      ) {
        const detail = labels.join(", ") || (before && after ? "entry order" : "")
        fields.add(`Model definitions${detail ? ` (${detail})` : ""}`)
      }
    }
  }
  if (
    saved.length === draft.length &&
    saved.every((provider) => draft.some((p) => p.id === provider.id)) &&
    different(
      saved.map((provider) => provider.id),
      draft.map((provider) => provider.id),
    )
  )
    fields.add("Provider order")
  return [...fields]
}

/** Describe policy-only fields and impact without including selection or endpoint values. */
export function policyChangeEntries(saved: Policy, draft: Policy): PolicyChange[] {
  const changes: PolicyChange[] = []
  for (const key of ["privateUsers", "groups"] as const) {
    const label = key === "privateUsers" ? "Private-message access" : "Group/channel access"
    for (const id of draft[key])
      if (!saved[key].includes(id))
        changes.push({
          label: `${label}: approve ${id}`,
          targets: [
            {
              page: "Chats",
              selector: key === "privateUsers" ? "#access-users-list" : "#access-groups-list",
            },
          ],
        })
    for (const id of saved[key])
      if (!draft[key].includes(id))
        changes.push({
          label: `${label}: revoke ${id}`,
          targets: [
            {
              page: "Chats",
              selector: key === "privateUsers" ? "#access-users-list" : "#access-groups-list",
            },
          ],
        })
  }
  for (const id of new Set([...Object.keys(saved.chats), ...Object.keys(draft.chats)])) {
    const before = saved.chats[id]
    const after = draft.chats[id]
    const fields = selectionChanges(before, after, true)
    if (before?.enabled !== after?.enabled)
      fields.push(after ? "Enabled switch" : "Enabled switch (reset)")
    if (fields.length) {
      const action = !before ? "added settings; " : !after ? "removed settings; " : ""
      const changed = selectionFields.find(([key]) =>
        differentSelection(before?.[key] ?? null, after?.[key] ?? null),
      )?.[0]
      const selector =
        changed === "tools" || changed === "servers" || changed === "skills" || changed === "models"
          ? `#chat-${changed}-options`
          : changed === "thinking"
            ? "#thinking-selection"
            : changed === "model"
              ? "#model-selection"
              : "#chat-policy-enabled"
      changes.push({
        label: `Chat ${id}: ${action}${fields.join(", ")} — this chat only; shared defaults and access approval unchanged.`,
        targets: [{ page: "Chats", chat: id, selector }],
      })
    }
  }
  for (const [before, after, action] of [
    [saved.githubNotifications.allowedUsernames, draft.githubNotifications.allowedUsernames, "add"],
    [
      draft.githubNotifications.allowedUsernames,
      saved.githubNotifications.allowedUsernames,
      "remove",
    ],
  ] as const)
    for (const username of after)
      if (!before.includes(username))
        changes.push({
          label: `GitHub mentions: ${action} username ${username} — automatic replies on GitHub; no Telegram chat or tool permission dependency.`,
          targets: [{ page: "GitHub mentions", selector: "#github-mention-authors" }],
        })
  for (const [key, label] of [
    ["providers", "service"],
    ["chatIds", "destination"],
  ] as const) {
    for (const [before, after, action] of [
      [saved.statusNotifications[key], draft.statusNotifications[key], "add"],
      [draft.statusNotifications[key], saved.statusNotifications[key], "remove"],
    ] as const) {
      for (const value of after) {
        if ((before as readonly (string | number)[]).includes(value)) continue
        changes.push({
          label: `Service status: ${action} ${label} ${typeof value === "number" ? value : statusProviderNames[value]} — notification-only; does not grant Pi access.`,
          targets: [
            {
              page: "Service status",
              selector:
                key === "providers"
                  ? "#status-notification-services"
                  : "#status-notification-destinations",
            },
          ],
        })
      }
    }
  }
  for (const [key, label, selector] of statusFields) {
    const before = saved.statusNotifications[key]
    const after = draft.statusNotifications[key]
    if (before === after) continue
    const format = (value: typeof before) =>
      typeof value === "boolean"
        ? value
          ? "on"
          : "off"
        : key === "pollIntervalSeconds"
          ? `${value} seconds`
          : value
    changes.push({
      label: `Service status: ${label} ${format(before)} → ${format(after)} — ${key === "minimumImpact" ? "shared default; explicit chat impact overrides unchanged" : "applies to all notification destinations"}; does not grant Pi access.`,
      targets: [{ page: "Service status", selector }],
    })
  }
  changes.push(...statusFilterChanges(saved.statusNotifications, draft.statusNotifications).entries)
  const defaults = selectionChanges(saved.defaults, draft.defaults, false)
  if (defaults.length)
    changes.push({
      label: `Shared defaults: ${defaults.join(", ")} — affects chats inheriting each changed field; explicit overrides unchanged; does not grant access.`,
      targets: selectionFields
        .filter(([key]) =>
          differentSelection(saved.defaults[key] ?? null, draft.defaults[key] ?? null),
        )
        .map(
          ([key]): EditorTarget =>
            key === "tools" || key === "servers"
              ? { page: "Tool permissions", selector: "#default-tool-permissions" }
              : key === "skills"
                ? { page: "Skills", selector: "#skill-search" }
                : { page: "Defaults", selector: "#default-model-settings" },
        ),
    })
  for (const [key, label] of [
    ["tools", "Global tool availability"],
    ["skills", "Global skill availability"],
    ["servers", "Global MCP availability"],
    ["models", "Global model availability"],
  ] as const)
    if (differentSelection(saved[key], draft[key]))
      changes.push({
        label: `${label} (${key}): limits shared defaults and all chat selections, including explicit overrides; does not grant access.`,
        targets: [
          key === "skills"
            ? { page: "Skills", selector: "#skill-search" }
            : key === "models"
              ? { page: "Model Providers", selector: "#model-availability" }
              : { page: "Tool permissions", selector: "#default-tool-permissions" },
        ],
      })
  const providers = providerChanges(saved.providers, draft.providers)
  if (providers.length)
    changes.push({
      label: `Provider configuration: ${providers.join(", ")} — global provider settings; may affect chats using these providers, including explicit overrides.`,
      targets: [{ page: "Model Providers", selector: "#endpoint-provider-id" }],
    })
  return changes
}

/** Count edited fields and changed list memberships, not grouped review summaries. */
export function policyChangeCount(saved: Policy, draft: Policy): number {
  const listCount = (
    before: readonly (string | number)[] | null | undefined,
    after: readonly (string | number)[] | null | undefined,
  ) => {
    if (!different(before ?? null, after ?? null)) return 0
    if (before == null || after == null) return 1
    return new Set([
      ...before.filter((value) => !after.includes(value)),
      ...after.filter((value) => !before.includes(value)),
    ]).size
  }
  const selectionCount = (before?: Selection, after?: Selection) =>
    selectionFields.reduce(
      (count, [key]) =>
        count +
        (["model", "thinking"].includes(key)
          ? Number(different(before?.[key] ?? null, after?.[key] ?? null))
          : listCount(before?.[key] as string[] | null, after?.[key] as string[] | null)),
      0,
    )
  let count = selectionCount(saved.defaults, draft.defaults)
  count += listCount(
    saved.githubNotifications.allowedUsernames,
    draft.githubNotifications.allowedUsernames,
  )
  for (const key of ["providers", "chatIds"] as const)
    count += listCount(saved.statusNotifications[key], draft.statusNotifications[key])
  for (const [key] of statusFields)
    count += Number(saved.statusNotifications[key] !== draft.statusNotifications[key])
  count += statusFilterChanges(saved.statusNotifications, draft.statusNotifications).count
  for (const key of ["privateUsers", "groups", "tools", "servers", "skills", "models"] as const)
    count += listCount(saved[key], draft[key])
  for (const id of new Set([...Object.keys(saved.chats), ...Object.keys(draft.chats)])) {
    count += selectionCount(saved.chats[id], draft.chats[id])
    count += Number(saved.chats[id]?.enabled !== draft.chats[id]?.enabled)
  }
  for (const id of new Set(
    [...saved.providers, ...draft.providers].map((provider) => provider.id),
  )) {
    const before = saved.providers.find((provider) => provider.id === id)
    const after = draft.providers.find((provider) => provider.id === id)
    if (!before || !after) {
      count++
      continue
    }
    for (const key of ["enabled", "baseUrl", "api"] as const)
      count += Number(different(before[key], after[key]))
    for (const modelId of new Set([...before.models, ...after.models].map((model) => model.id))) {
      const oldModel = before.models.find((model) => model.id === modelId)
      const newModel = after.models.find((model) => model.id === modelId)
      if (!oldModel || !newModel) {
        count++
        continue
      }
      for (const key of ["name", "reasoning", "image", "contextWindow", "maxTokens"] as const)
        count += Number(different(oldModel[key], newModel[key]))
    }
    if (
      before.models.length === after.models.length &&
      before.models.every((model) => after.models.some((item) => item.id === model.id))
    )
      count += Number(
        different(
          before.models.map((model) => model.id),
          after.models.map((model) => model.id),
        ),
      )
  }
  if (
    saved.providers.length === draft.providers.length &&
    saved.providers.every((provider) => draft.providers.some((item) => item.id === provider.id))
  )
    count += Number(
      different(
        saved.providers.map((provider) => provider.id),
        draft.providers.map((provider) => provider.id),
      ),
    )
  return count
}

export function policyChanges(saved: Policy, draft: Policy): string[] {
  return policyChangeEntries(saved, draft).map((change) => change.label)
}
